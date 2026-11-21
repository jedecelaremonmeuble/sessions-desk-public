// Réglages du serveur — les paramètres de legacy/sessions-dashboard.ps1, plus ce que la cohabitation impose.
//
// Cohabitation (lot 2b, étape 4) : le serveur Node tourne À CÔTÉ du .ps1 (8767, relais 8768) et lit les mêmes
// fichiers. Le seul point de conflit est l'écriture (favoris, masquage, journal des envois…) : il est donc en
// LECTURE SEULE par défaut (--allow-write pour écrire), et en rôle « side » il ne fait aucune tâche de fond qui
// écrit dans un fichier partagé ou se voit (notifications, index de recherche, état des PR, « vu », alertes du
// lanceur) : le .ps1 de production s'en charge. Rôle « primary » = après la bascule sur 8765 (étape 5).
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeArgsOk, loadSettings, type Modules, type TagVocab, type UiConfig } from './modules.ts';

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
  /** Chemin du fichier de configuration lu (passé au surveillant Teams lancé par le serveur : SD_CONFIG). */
  configFile: string;
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
    notifyAfterSeconds: num('--notify-after', settings.delays.notifyAfterSeconds ?? 15),
    notifyDoneAfterMinutes: num('--notify-done-after', settings.delays.notifyDoneAfterMinutes ?? 3),
    closedDays: num('--closed-days', settings.delays.closedDays ?? 14),
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
    configFile,
  };
}
