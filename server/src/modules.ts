// MODULES OPTIONNELS — ce qui n'appartient pas au cœur (liste des sessions, écran, conversation, envoi).
//
// Le cœur ne lit que ~/.claude et pilote des consoles. Tout le reste est une intégration propre à un poste ou à
// une équipe : elle est ÉTEINTE tant que le fichier de configuration ne la nomme pas.
//
//   ~/.claude/sessions-desk/config.json      (autre chemin : --config <fichier>, ou SD_CONFIG)
//   {
//     "modules": {
//       "launcher": { "root": "%LOCALAPPDATA%\\mon-orchestrateur", "cli": "C:\\chemin\\orchestrateur.py", "ticketApi": "C:\\chemin\\tickets.py", "python": "python" },
//       "teams":    { "enabled": true },
//       "tickets":  { "pattern": "ABC-\\d{4}" },
//       "quota":    { "file": "%LOCALAPPDATA%\\mon-orchestrateur\\claude-usage.json" },
//       "automations": [
//         { "id": "nettoyage", "label": "Nettoyage", "icon": "🧹", "everyMinutes": 60,
//           "history": "%LOCALAPPDATA%\\nettoyage\\history.jsonl", "runs": "%LOCALAPPDATA%\\nettoyage\\runs",
//           "cli": "C:\\chemin\\nettoyage.py", "python": "python",
//           "orders": [ { "id": "essai", "label": "À blanc", "args": ["run", "--dry-run"] },
//                       { "id": "vrai", "label": "Passe réelle", "args": ["run"], "confirm": "Lancer une vraie passe ?" } ] }
//       ]
//     },
//     "ui": { "pathPrefix": "C:\\code\\mon-depot", "prUrl": "https://github.com/moi/depot/pull/", "ticketUrl": "https://tickets.example.com/t/", "ticketLabel": "Ticket" },
//     "claudeArgs": "--model opus",
//     "delays": { "notifyAfterSeconds": 15, "notifyDoneAfterMinutes": 3, "closedDays": 14 },
//     "tailscaleExe": "C:\\Program Files\\Tailscale\\tailscale.exe",
//     "newSession": { "folders": ["C:\\code\\mon-depot", "~\\outils"] }
//   }
//
// - ui.quota : { "warn": 75, "alert": 90 } — seuils (en %) du quota hebdomadaire : orange, puis rouge + alerte.
// - delays : notification d'une session qui attend (s), d'une session terminée après un long tour (min), fenêtre
//   des sessions fermées (jours). Les options --notify-after, --notify-done-after, --closed-days passent avant.
// - tailscaleExe : chemin de tailscale.exe ("" : pas d'accès distant). L'option --tailscale passe avant.
// - peers : ["autre-poste"] — noms, sur le tailnet, de tes autres postes qui font tourner ce serveur : leurs sessions
//   s'ajoutent à la liste de celui-ci (peers.ts). Absente : rien ne change.
// - newSession.folders : dossiers TOUJOURS proposés par le formulaire « Nouvelle session », même sans session récente
//   (sinon seuls ceux où une session a tourné le sont). Seuls ces dossiers-là s'ajoutent à ce que le serveur accepte.
//
// - ui.models : coût relatif de chaque modèle, pour que la page dise d'un coup d'œil qu'une session coûte plus cher.
//   `match` = morceau de l'identifiant du modèle (« fable », « claude-opus-5-5 » ; la première entrée qui correspond
//   l'emporte), `cost` = multiplicateur par rapport au modèle de référence (celui à 1), `note` = précision affichée
//   au survol (tarif…). Absente : la table publique ci-dessous (DEFAULT_MODELS). Présente, elle la REMPLACE.
//
// - ui.shortcuts : boutons de la page qui envoient une commande « / » toute faite à une session —
//   [{ "label": "Reconnecter", "command": "/mcp reconnect all", "confirm": "" }], 8 au plus. Absente : deux
//   raccourcis par défaut (reconnecter les serveurs MCP, compacter). Liste vide : aucun bouton.
//
// - claudeArgs : options passées à `claude` quand la page ouvre, rouvre ou relance une session. Aucune par défaut ;
//   l'option --claude-args de la ligne de commande passe avant.
//
// - launcher : un orchestrateur externe qui lance des sessions sans terminal. `root` = son dossier de données
//   (runs\, state.json, stages.json, heartbeat.stamp) ; `cli` = la commande qui reçoit les ordres tapés dans la page.
// - teams    : attentes de réponse Teams tenues par teams-watcher.ts (state/teams-waits).
// - tickets  : motif des références de ticket citées dans les prompts (le « sujet actuel » d'une session).
// - quota    : relevé du quota par compte Claude — `{ "source": "usage-probe" }` : la sonde intégrée
//              (usage-probe.ts, écran /usage de Claude Code, sans jeton) ; ou `{ "file": … }` : le relevé d'un
//              collecteur extérieur.
// - automations : scripts planifiés du poste (automations.ts). Chacun tient un historique JSONL dont chaque ligne
//   porte une clé `pass` au format commun ; `runs` = dossier de ses passes (fichiers servis, passe en cours) ;
//   `cli` + `orders` = « Lancer maintenant ». Un automate mal décrit est ignoré, sans éteindre les autres.
//
// Fichier absent, illisible ou module mal décrit ⇒ module éteint : jamais une erreur au démarrage.
import { readFileSync } from 'node:fs';
import { parsePeers } from './peers.ts';
import { isAbsolute, join } from 'node:path';
import { parseShortcuts, type Shortcut } from './commands.ts';

export interface LauncherModule { root: string; cli: string; python: string; ticketApi: string; cardsApi: string }
/** Ce que la page affiche et qui dépend du poste : préfixe de chemin à ne pas répéter, adresses des PR et des tickets. */
export interface UiConfig { pathPrefix: string; prUrl: string; ticketUrl: string; ticketLabel: string; language: '' | 'en' | 'fr'; models: ModelCost[]; quota: QuotaLevels;
  /** Boutons qui envoient une commande « / » toute faite. null : ceux par défaut (commands.ts) ; [] : aucun. */
  shortcuts: Shortcut[] | null }
/** Seuils du quota hebdomadaire (en %) : `warn` = orange, `alert` = rouge + alerte du lanceur. */
export interface QuotaLevels { warn: number; alert: number }
export const DEFAULT_QUOTA: QuotaLevels = Object.freeze({ warn: 75, alert: 90 });
/** Coût relatif d'un modèle : `cost` = multiplicateur par rapport au modèle de référence (cost 1). `offer` : proposé
 *  dans le formulaire « Nouvelle session » (`match` est alors passé tel quel à `claude --model`). */
export interface ModelCost { match: string; label: string; cost: number; note: string; offer: boolean }
/** Table par défaut : tarifs publics de l'API Anthropic (entrée / sortie, par million de tokens), relatifs à Opus.
 *  Sur un abonnement, le même rapport vaut pour la vitesse à laquelle le quota s'épuise. */
export const DEFAULT_MODELS: readonly ModelCost[] = Object.freeze([
  { match: 'opus', label: 'Opus', cost: 1, note: '4 $ / 20 $', offer: true },
  { match: 'sonnet', label: 'Sonnet', cost: 0.5, note: '2 $ / 10 $', offer: true },
  { match: 'haiku', label: 'Haiku', cost: 0.025, note: '0,10 $ / 0,50 $', offer: true },
  { match: 'fable', label: 'Fable', cost: 2, note: '8 $ / 40 $', offer: true },
  { match: 'mythos', label: 'Mythos', cost: 2, note: '8 $ / 40 $', offer: false },
]);
export const NO_UI: UiConfig = { pathPrefix: '', prUrl: '', ticketUrl: '', ticketLabel: '', language: '', models: [...DEFAULT_MODELS], quota: { ...DEFAULT_QUOTA }, shortcuts: null };
/** Ordre « Lancer maintenant » d'un automate : `python <cli> <args…>`. `confirm` non vide ⇒ la page demande avant. */
export interface AutomationOrder { id: string; label: string; args: string[]; confirm: string }
export interface AutomationDef {
  id: string; label: string; icon: string;
  history: string;              // historique JSONL (une ligne par passe, clé `pass`)
  runs: string;                 // dossier des passes ('' : ni fichiers servis, ni passe en cours repérée)
  cli: string; python: string;  // commande des ordres ('' : pas d'ordre)
  everyMinutes: number | null;  // période de la tâche planifiée : « prochaine passe » sur la carte
  orders: AutomationOrder[];
}
export interface Modules {
  launcher: LauncherModule | null;
  teams: boolean;
  tickets: { pattern: string } | null;
  quota: { file: string; probe?: boolean } | null;
  automations: AutomationDef[];
}
export const NO_MODULES: Modules = { launcher: null, teams: false, tickets: null, quota: null, automations: [] };

/** Ce que la page reçoit (`/api/state.modules`) : allumé ou non, jamais un chemin. */
export const modulesView = (m: Modules): Record<string, boolean> =>
  ({ launcher: !!m.launcher, teams: m.teams, tickets: !!m.tickets, quota: !!m.quota, automations: m.automations.length > 0 });

export interface PathEnv { home: string; localAppData: string; temp: string }

/** `~`, %USERPROFILE%, %LOCALAPPDATA% et %TEMP% en tête ou dans un chemin ; rien d'autre n'est développé. */
export function expandPath(p: string, env: PathEnv): string {
  let s = p.replace(/%USERPROFILE%/gi, env.home).replace(/%LOCALAPPDATA%/gi, env.localAppData).replace(/%TEMP%/gi, env.temp);
  if (s === '~') s = env.home; else if (/^~[\\/]/.test(s)) s = join(env.home, s.slice(2));
  return s;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const absPath = (v: unknown, env: PathEnv): string => { if (typeof v !== 'string' || !v.trim()) return ''; const p = expandPath(v.trim(), env); return isAbsolute(p) ? p : ''; };

/** Un motif de ticket n'est gardé que s'il compile et ne matche pas le vide (sinon chaque prompt aurait un « sujet »). */
export function ticketPattern(v: unknown): string | null {
  if (typeof v !== 'string' || !v || v.length > 200) return null;
  try { return new RegExp(v).test('') ? null : v; } catch { return null; }
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').trim().slice(0, max) : '');
/** Arguments d'un ordre : 20 chaînes au plus, sans saut de ligne ni guillemet (ils iraient tels quels à `python`). */
function orderArgs(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > 20) return null;
  return v.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 200 && !/[\r\n"]/.test(a)) ? v as string[] : null;
}
/** Un automate n'est gardé que bien décrit (id, libellé, historique en chemin absolu) ; ses ordres, que s'il a une commande. */
export function parseAutomations(v: unknown, env: PathEnv): AutomationDef[] {
  if (!Array.isArray(v)) return [];
  const out: AutomationDef[] = []; const seen = new Set<string>();
  for (const x of v.slice(0, 20)) {
    const a = obj(x); if (!a) continue;
    const id = typeof a.id === 'string' ? a.id : ''; const label = text(a.label, 60); const history = absPath(a.history, env);
    if (!ID.test(id) || seen.has(id) || !label || !history) continue;
    seen.add(id);
    const cli = absPath(a.cli, env);
    const orders: AutomationOrder[] = []; const oseen = new Set<string>();
    if (cli && Array.isArray(a.orders)) {
      for (const y of a.orders.slice(0, 6)) {
        const o = obj(y); const oid = typeof o?.id === 'string' ? o.id : ''; const ol = text(o?.label, 40); const args = orderArgs(o?.args);
        if (!o || !ID.test(oid) || oseen.has(oid) || !ol || !args) continue;
        oseen.add(oid); orders.push({ id: oid, label: ol, args, confirm: typeof o.confirm === 'string' ? o.confirm.trim().slice(0, 400) : '' });   // texte de confirm() : sauts de ligne gardés
      }
    }
    const every = typeof a.everyMinutes === 'number' && Number.isFinite(a.everyMinutes) && a.everyMinutes >= 1 && a.everyMinutes <= 7 * 24 * 60 ? a.everyMinutes : null;
    out.push({ id, label, icon: text(a.icon, 8), history, runs: absPath(a.runs, env), cli,
      python: typeof a.python === 'string' && a.python.trim() ? a.python.trim() : 'python', everyMinutes: every, orders });
  }
  return out;
}

export function parseModules(raw: unknown, env: PathEnv): Modules {
  const m = obj(obj(raw)?.modules); if (!m) return { ...NO_MODULES };
  const out: Modules = { ...NO_MODULES };
  out.automations = parseAutomations(m.automations, env);
  const l = obj(m.launcher); const root = l ? absPath(l.root, env) : '';
  if (l && root) out.launcher = { root, cli: absPath(l.cli, env), python: typeof l.python === 'string' && l.python.trim() ? l.python.trim() : 'python', ticketApi: absPath(l.ticketApi, env), cardsApi: absPath(l.cardsApi, env) };
  out.teams = obj(m.teams)?.enabled === true;
  const pat = ticketPattern(obj(m.tickets)?.pattern); if (pat) out.tickets = { pattern: pat };
  // quota : { "source": "usage-probe" } = la sonde intégrée (usage-probe.ts) écrit et lit son propre relevé ;
  // sinon { "file": … } = relevé d'un collecteur extérieur (forme historique, toujours lue).
  const q = obj(m.quota);
  if (q && q.source === 'usage-probe') out.quota = { file: join(env.localAppData, 'sessions-desk', 'usage-probe.json'), probe: true };
  else { const file = q ? absPath(q.file, env) : ''; if (file) out.quota = { file }; }
  return out;
}

const httpUrl = (v: unknown): string => (typeof v === 'string' && /^https?:\/\/[^\s"'<>]+$/i.test(v.trim()) ? v.trim() : '');
export function parseUi(raw: unknown, env: PathEnv): UiConfig {
  const u = obj(obj(raw)?.ui); if (!u) return { ...NO_UI };
  const label = typeof u.ticketLabel === 'string' ? u.ticketLabel.trim().slice(0, 30) : '';
  // language : langue de la page sur ce poste ('en' ou 'fr') ; vide = celle du navigateur. Un choix fait dans la page l'emporte.
  const language = u.language === 'en' || u.language === 'fr' ? u.language : '';
  return { pathPrefix: absPath(u.pathPrefix, env), prUrl: httpUrl(u.prUrl), ticketUrl: httpUrl(u.ticketUrl), ticketLabel: label, language, models: parseModels(u.models), quota: parseQuotaLevels(u.quota), shortcuts: parseShortcuts(u.shortcuts) };
}

/** `ui.models` : 30 entrées au plus ; une entrée sans `match` ou sans coût positif est ignorée. Liste absente,
 *  vide ou entièrement fausse ⇒ la table par défaut (jamais une page sans repère de coût). */
export function parseModels(v: unknown): ModelCost[] {
  if (!Array.isArray(v)) return [...DEFAULT_MODELS];
  const txt = (x: unknown, n: number): string => (typeof x === 'string' ? x.trim().slice(0, n) : '');
  const out: ModelCost[] = [];
  for (const e of v.slice(0, 30)) {
    const o = obj(e); if (!o) continue;
    const match = txt(o.match, 60).toLowerCase(), cost = Number(o.cost);
    if (!match || !Number.isFinite(cost) || cost <= 0 || cost > 1000) continue;
    out.push({ match, label: txt(o.label, 30) || match, cost, note: txt(o.note, 120), offer: o.offer !== false });
  }
  return out.length ? out : [...DEFAULT_MODELS];
}

/** `ui.quota` : { "warn": 75, "alert": 90 } — entiers de 1 à 100, `warn` < `alert` ; sinon les valeurs par défaut. */
export function parseQuotaLevels(v: unknown): QuotaLevels {
  const o = obj(v); const pct = (x: unknown, d: number): number => (typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 100 ? x : d);
  const warn = pct(o?.warn, DEFAULT_QUOTA.warn), alert = pct(o?.alert, DEFAULT_QUOTA.alert);
  return warn < alert ? { warn, alert } : { ...DEFAULT_QUOTA };
}

/** Délais du serveur (clé `delays`) : chacun facultatif ; l'option de même rôle en ligne de commande passe avant. */
export interface Delays { notifyAfterSeconds?: number; notifyDoneAfterMinutes?: number; closedDays?: number }
export function parseDelays(raw: unknown): Delays {
  const o = obj(obj(raw)?.delays); if (!o) return {};
  const n = (x: unknown, max: number): number | undefined => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= max ? x : undefined);
  const out: Delays = {};
  const a = n(o.notifyAfterSeconds, 3600), b = n(o.notifyDoneAfterMinutes, 24 * 60), c = n(o.closedDays, 365);
  if (a !== undefined) out.notifyAfterSeconds = a;
  if (b !== undefined) out.notifyDoneAfterMinutes = b;
  if (c !== undefined) out.closedDays = c;
  return out;
}
/** Clé `tailscaleExe` : chemin absolu de tailscale.exe, ou "" pour couper l'accès distant. Absente ou invalide ⇒ undefined. */
export function parseTailscale(raw: unknown, env: PathEnv): string | undefined {
  const v = obj(raw)?.tailscaleExe; if (v === '') return ''; if (typeof v !== 'string') return undefined;
  return absPath(v, env) || undefined;
}

/** Clé `newSession.folders` : dossiers déclarés du formulaire « Nouvelle session ». Chemins absolus seulement (`~`,
 *  %USERPROFILE%… développés), sans « ; » ni « " » (ils couperaient la ligne de commande de Windows Terminal),
 *  50 au plus, doublons retirés (casse ignorée) ; une entrée invalide est ignorée sans éteindre les autres. */
export function parseNewSessionFolders(raw: unknown, env: PathEnv): string[] {
  const v = obj(obj(raw)?.newSession)?.folders; if (!Array.isArray(v)) return [];
  const out: string[] = [], seen = new Set<string>();
  for (const x of v.slice(0, 50)) {
    let p = absPath(x, env); if (!p || /[;"\r\n]/.test(p)) continue;
    if (p.length > 3) p = p.replace(/[\\/]+$/, '');
    const k = p.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(p); }
  }
  return out;
}

/** Options passées à `claude` au lancement d'une session : une ligne de 200 caractères au plus, sans « ; » (qui
 *  couperait la ligne de commande de Windows Terminal). Autre chose ⇒ null. */
export function claudeArgsOk(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 200 || /[\r\n;]/.test(v)) return null;
  return v.trim();
}
/** Clé de premier niveau `claudeArgs` : absente ou refusée ⇒ aucune option (défaut de la version publique). */
export const parseClaudeArgs = (raw: unknown): string => claudeArgsOk(obj(raw)?.claudeArgs) ?? '';

/** Fichier de configuration du poste, lu une fois : `modules`, `ui` et `claudeArgs`. */
/** Vocabulaire des axes fermés des tags (domaines, outils) : section `tagger` (domains, tools[].v). « Autre » n'en est pas. */
export interface TagVocab { domaines: string[]; outils: string[] }
export function parseTagVocab(raw: unknown): TagVocab {
  const t = obj(obj(raw)?.tagger); if (!t) return { domaines: [], outils: [] };
  const domaines = Array.isArray(t.domains) ? t.domains.filter((x): x is string => typeof x === 'string' && x !== 'Autre') : [];
  const outils = Array.isArray(t.tools) ? t.tools.map((r) => obj(r)?.v).filter((x): x is string => typeof x === 'string') : [];
  return { domaines, outils };
}

export interface Settings { modules: Modules; ui: UiConfig; claudeArgs: string; delays: Delays; tailscaleExe?: string; tagVocab: TagVocab;
  /** Dossiers déclarés du formulaire « Nouvelle session » (parseNewSessionFolders). */
  newFolders: string[];
  /** Autres postes du même propriétaire dont les sessions s'affichent ici (peers.ts). */
  peers: string[];
  /** Fichier présent mais illisible (JSON invalide) : le message, avec la position. null : lu, ou absent. */
  error: string | null }
export function loadSettings(file: string, env: PathEnv): Settings {
  const none = (error: string | null): Settings => ({ modules: { ...NO_MODULES }, ui: { ...NO_UI }, claudeArgs: '', delays: {}, tagVocab: { domaines: [], outils: [] }, newFolders: [], peers: [], error });
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return none(null); }   // absent : rien d'allumé, ce n'est pas une erreur
  let raw: unknown;
  // Illisible : tout reste éteint, mais on le DIT (un seul fichier porte tous les modules : une virgule de trop les éteint tous).
  try { raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch (e) { return none(`${file} : ${(e as Error).message}`); }
  const ts = parseTailscale(raw, env);
  return { modules: parseModules(raw, env), ui: parseUi(raw, env), claudeArgs: parseClaudeArgs(raw), delays: parseDelays(raw), tagVocab: parseTagVocab(raw), newFolders: parseNewSessionFolders(raw, env), peers: parsePeers(raw), error: null, ...(ts !== undefined ? { tailscaleExe: ts } : {}) };
}
export const loadModules = (file: string, env: PathEnv): Modules => loadSettings(file, env).modules;
