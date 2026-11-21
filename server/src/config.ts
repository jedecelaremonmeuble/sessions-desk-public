// Réglages du serveur — ligne de commande et config.json du poste.
//
// Deux rôles. Sur 8765 (ou --primary) : le serveur PRINCIPAL du poste, écriture permise, tâches de fond, fichiers
// d'état sans suffixe. Ailleurs (8767 par défaut) : une instance SECONDAIRE à côté du principal, qui lit les mêmes
// fichiers. Le seul point de conflit est l'écriture (favoris, masquage, journal des envois…) : elle est donc en
// LECTURE SEULE par défaut (--allow-write pour écrire), et en rôle « side » elle ne fait aucune tâche de fond qui
// écrit dans un fichier partagé ou se voit (notifications, index de recherche, état des PR, « vu », alertes du
// lanceur) : le principal s'en charge. Ce rôle vient de la migration depuis le serveur PowerShell historique.
import { existsSync, unwatchFile, watchFile } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeArgsOk, loadSettings, type Modules, type Settings, type TagVocab, type UiConfig } from './modules.ts';

export interface Config {
  port: number;
  url: string;            // http://localhost:<port>/
  origin: string;         // http://localhost:<port>
  home: string;
  claude: string;         // ~/.claude
  localAppData: string;
  temp: string;
  /** Fichiers d'état propres à un serveur : suffixés hors du port de production (« -8767 »). */
  suffix: string;
  noBackground: boolean;
  allowWrite: boolean;
  primary: boolean;
  notifyAfterSeconds: number;
  notifyDoneAfterMinutes: number;
  closedDays: number;
  claudeArgs: string;
  pageDir: string;
  legacyDir: string;
  driverExe: string;
  /** Tailscale : null = lire `tailscale status` ; '' = pas d'accès distant en écriture. */
  tailscaleExe: string;
  /** Intégrations optionnelles (modules.ts) : éteintes tant que le fichier de configuration ne les nomme pas. */
  modules: Modules;
  /** Réglages d'affichage propres au poste (modules.ts, UiConfig). */
  ui: UiConfig;
  /** Vocabulaire des tags, à défaut de celui que publie l'étiqueteur (modules.ts, parseTagVocab). */
  tagVocab: TagVocab;
  /** Dossiers toujours proposés (et acceptés) par « Nouvelle session » — `newSession.folders` de config.json. */
  newFolders: string[];
  /** Autres postes dont les sessions s'ajoutent à la liste (peers.ts) ; vide : aucun. */
  peers: string[];
  /** config.json illisible : le message (affiché par la page). */
  configError: string | null;
  /** config.json lu mais pas conforme au schéma : une ligne par réglage ignoré (affiché par la page). */
  configWarnings: string[];
  /** config.json devenu illisible APRÈS le démarrage : les réglages d'avant restent en vigueur (rien ne s'éteint). */
  configErrorKept: boolean;
  /** Réglages modifiés depuis le démarrage qui ne s'appliquent qu'au prochain (RESTART_KEYS). */
  configRestart: string[];
  /** Réglages imposés par la ligne de commande : une modification de config.json ne les touche pas. */
  pinned: { claudeArgs: boolean; notifyAfterSeconds: boolean; notifyDoneAfterMinutes: boolean; closedDays: boolean };
  /** Empreinte, au démarrage, des réglages qui demandent un redémarrage (restartKeys). */
  bootKeys: Record<string, string>;
  /** Chemin du fichier de configuration lu (passé au surveillant Teams lancé par le serveur : SD_CONFIG). */
  configFile: string;
}

const DEFAULT_DELAYS = { notifyAfterSeconds: 15, notifyDoneAfterMinutes: 3, closedDays: 14 } as const;

// ───────────── rechargement à chaud ─────────────
// config.json modifié pendant que le serveur tourne : ce qui est relu à chaque usage s'applique tout de suite (affichage,
// coût des modèles, seuils du quota, raccourcis, délais, options de claude, dossiers de « Nouvelle session », motif des
// tickets, vocabulaire des tags). Ce qui est monté au démarrage (tâches de fond, routes, relais) ne change qu'au prochain :
// la page le dit, réglage par réglage. Le surveillant Teams et l'étiqueteur relisent le fichier à chaque passe.

/** Réglages montés au démarrage : modifiés, ils attendent un redémarrage. */
export const RESTART_KEYS = ['modules.launcher', 'modules.teams', 'modules.quota', 'modules.automations', 'tailscaleExe', 'peers'] as const;
export function restartKeys(s: Settings): Record<string, string> {
  const v: Record<(typeof RESTART_KEYS)[number], unknown> = {
    'modules.launcher': s.modules.launcher, 'modules.teams': s.modules.teams, 'modules.quota': s.modules.quota,
    'modules.automations': s.modules.automations, tailscaleExe: s.tailscaleExe ?? null, peers: s.peers,
  };
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, JSON.stringify(x ?? null)]));
}

/** Applique des réglages relus à la configuration EN SERVICE (en place : tout le serveur tient le même objet).
 *  Fichier devenu illisible : on le dit, et rien d'autre ne change — une virgule de trop n'éteint pas un serveur qui tourne. */
export function applySettings(cfg: Config, s: Settings): void {
  if (s.error) { cfg.configError = s.error; cfg.configErrorKept = true; return; }
  cfg.configError = null; cfg.configErrorKept = false; cfg.configWarnings = s.warnings;
  cfg.ui = s.ui; cfg.tagVocab = s.tagVocab; cfg.newFolders = s.newFolders;
  cfg.modules = { ...cfg.modules, tickets: s.modules.tickets };
  if (!cfg.pinned.claudeArgs) cfg.claudeArgs = s.claudeArgs;
  if (!cfg.pinned.notifyAfterSeconds) cfg.notifyAfterSeconds = s.delays.notifyAfterSeconds ?? DEFAULT_DELAYS.notifyAfterSeconds;
  if (!cfg.pinned.notifyDoneAfterMinutes) cfg.notifyDoneAfterMinutes = s.delays.notifyDoneAfterMinutes ?? DEFAULT_DELAYS.notifyDoneAfterMinutes;
  if (!cfg.pinned.closedDays) cfg.closedDays = s.delays.closedDays ?? DEFAULT_DELAYS.closedDays;
  const now = restartKeys(s);
  cfg.configRestart = RESTART_KEYS.filter((k) => now[k] !== cfg.bootKeys[k]);
}

/** Relit config.json et l'applique. Rend une ligne pour le journal. */
export function reloadConfig(cfg: Config): string {
  const s = loadSettings(cfg.configFile, { home: cfg.home, localAppData: cfg.localAppData, temp: cfg.temp });
  applySettings(cfg, s);
  if (s.error) return `config.json illisible, réglages précédents gardés : ${s.error}`;
  return `config.json relu${s.warnings.length ? ` (${s.warnings.length} réglage(s) ignoré(s))` : ''}${cfg.configRestart.length ? ` ; au prochain démarrage : ${cfg.configRestart.join(', ')}` : ''}`;
}

/** Surveille config.json (relevé toutes les `intervalMs` : sûr avec les éditeurs qui remplacent le fichier). Rend l'arrêt. */
export function watchConfig(cfg: Config, onReload: (line: string) => void, intervalMs = 1000): () => void {
  let timer: NodeJS.Timeout | null = null;
  const listener = (cur: { mtimeMs: number; size: number }, prev: { mtimeMs: number; size: number }): void => {
    if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; try { onReload(reloadConfig(cfg)); } catch (e) { onReload(`config.json : relecture en échec (${(e as Error).message})`); } }, 200);
  };
  watchFile(cfg.configFile, { interval: intervalMs, persistent: false }, listener);
  return () => { if (timer) clearTimeout(timer); unwatchFile(cfg.configFile, listener); };
}

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Config {
  const opt = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const flag = (name: string): boolean => argv.includes(name);
  const num = (name: string, d: number): number => { const v = opt(name); const n = v === undefined ? d : Number(v); if (!Number.isFinite(n)) throw new Error(`${name} : nombre attendu`); return n; };
  const port = num('--port', 8767);
  const home = env.USERPROFILE ?? homedir();
  const primary = flag('--primary') || port === 8765;
  // Scripts d'accompagnement (focus-session.ps1) et page : dans legacy/ tant que le serveur historique est là,
  // sinon server/scripts/ et page/ (arbre publié).
  const legacyDir = resolve(opt('--legacy-dir') ?? (existsSync(join(REPO, 'legacy')) ? join(REPO, 'legacy') : join(REPO, 'server', 'scripts')));
  const localAppData = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'); const temp = env.TEMP ?? tmpdir();
  const configFile = resolve(opt('--config') ?? env.SD_CONFIG ?? join(home, '.claude', 'sessions-desk', 'config.json'));
  const settings = loadSettings(configFile, { home, localAppData, temp });
  // Options de `claude` : aucune par défaut ; le fichier de configuration du poste, puis --claude-args (prioritaire).
  const cliArgs = opt('--claude-args');
  const claudeArgs = cliArgs === undefined ? settings.claudeArgs : claudeArgsOk(cliArgs);
  if (claudeArgs === null) throw new Error('--claude-args : une ligne de 200 caractères au plus, sans « ; »');
  return {
    port,
    url: `http://localhost:${port}/`,
    origin: `http://localhost:${port}`,
    home,
    claude: join(home, '.claude'),
    localAppData,
    temp,
    suffix: port !== 8765 ? `-${port}` : '',
    noBackground: flag('--no-background'),
    allowWrite: flag('--allow-write') || primary,
    primary,
    notifyAfterSeconds: num('--notify-after', settings.delays.notifyAfterSeconds ?? DEFAULT_DELAYS.notifyAfterSeconds),
    notifyDoneAfterMinutes: num('--notify-done-after', settings.delays.notifyDoneAfterMinutes ?? DEFAULT_DELAYS.notifyDoneAfterMinutes),
    closedDays: num('--closed-days', settings.delays.closedDays ?? DEFAULT_DELAYS.closedDays),
    claudeArgs,
    pageDir: resolve(opt('--page-dir') ?? (existsSync(join(REPO, 'page')) ? join(REPO, 'page') : join(legacyDir, 'sessions-dashboard-page'))),
    legacyDir,
    driverExe: resolve(opt('--driver') ?? env.SD_DRIVER_EXE ?? join(REPO, '.build', 'driver', 'sessions-desk-driver.exe')),
    // Tailscale : --tailscale, puis `tailscaleExe` de config.json, puis l'emplacement d'installation standard.
    tailscaleExe: opt('--tailscale') ?? settings.tailscaleExe ?? join(env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
    modules: settings.modules,
    ui: settings.ui,
    tagVocab: settings.tagVocab,
    newFolders: settings.newFolders,
    peers: settings.peers,
    configError: settings.error,
    configWarnings: settings.warnings,
    configErrorKept: false,
    configRestart: [],
    pinned: { claudeArgs: cliArgs !== undefined, notifyAfterSeconds: opt('--notify-after') !== undefined, notifyDoneAfterMinutes: opt('--notify-done-after') !== undefined, closedDays: opt('--closed-days') !== undefined },
    bootKeys: restartKeys(settings),
    configFile,
  };
}
