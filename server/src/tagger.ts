// ÉTIQUETEUR DES SESSIONS.
// Lit les transcripts ~/.claude/projects/*/*.jsonl et écrit ~/.claude/state/session-tags/<sessionId>.json :
//   { sessionId, rulesVersion, computedAt, transcriptLen, acc, hdPending, tags: [{ axis, v, src }] }
// Règles : section `tagger` du fichier de configuration du poste (~/.claude/sessions-desk/config.json, ou --config,
// ou SD_CONFIG) — rien de propre à un poste ou à une équipe n'est écrit ici. `rulesVersion` est une empreinte de
// cette section : la modifier recalcule tous les tags.
// Les serveurs (.ps1 et Node) ne font que LIRE `tags`. Ce fichier est autonome (aucun import local) : -Deploy le copie
// tel quel dans ~/.claude/scripts/session-tagger/, la tâche planifiée « Claude - étiqueteur des sessions » le lance
// toutes les 5 min (`node tagger.ts`). Lecture INCRÉMENTALE : `acc` garde ce qui a été relevé et l'octet où la lecture
// s'est arrêtée ; un transcript qui grandit n'est relu que depuis là. Les règles s'appliquent à `acc` : changer les
// règles (empreinte rulesVersion) recalcule tout sans relire un seul transcript.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Axis = 'origine' | 'domaine' | 'outil' | 'fonction' | 'hd';
export interface Tag { axis: Axis; v: string; src: string }
export interface Rule { v: string; re: string[] }
/** Racine d'un dépôt dans un chemin absolu : `re` (sur le chemin en minuscules, séparateur « / ») capture en groupe 1
 *  le chemin relatif, auquel s'ajoute `prefix` devant. */
export interface Root { re: RegExp; prefix: string }
export interface TaggerConfig {
  rulesVersion: string; hdDomains: string[]; outils: Rule[]; domaines: Rule[]; claudeDocs: Record<string, string>;
  outilsSansDomaine?: string[]; hdApi: string; maxBytesPerPass: number; maxHdLookupsPerPass: number;
  /** Chemins → dépôt (relPath) et → nom de worktree (worktreeOf, groupe 1), dans l'ordre. */
  roots: Root[]; worktrees: RegExp[];
  /** Motif des références de ticket (modules.tickets.pattern) ; '' : aucune. */
  ticketPattern: string;
  /** Préfixes de chemin relatif dont topDirs garde 4 niveaux (au lieu de 2) ; mots qui ne disent rien d'une fonctionnalité. */
  deepDirs: string[]; genericWords: string[];
  /** Ce sur quoi portent les sessions, en une ligne, pour le petit modèle (« un logiciel de gestion », …). */
  context: string;
  /** Relevé du quota (claude-usage.json du lanceur) : '' si inconnu. */
  usageFile: string;
  /** petit modèle pour la fonctionnalité. Lots de `llmBatch` sessions, au plus `maxLlmBatchesPerPass` appels par
   *  passe, aucun appel si le quota de la semaine atteint `llmQuotaMaxPct` %. */
  llmModel?: string; llmBatch?: number; maxLlmBatchesPerPass?: number; llmQuotaMaxPct?: number; llmIdleMinutes?: number;
}
/** Ce que le petit modèle a proposé, et pour quel titre (un titre qui change ⇒ nouvelle question). */
export interface LlmResult { at: number; title: string | null; fonction: string[]; domaine: string | null; v?: number }
/** Version de la question posée au petit modèle : une réponse d'une version antérieure est redemandée.
 *  2 : pour une session du lanceur, la fonctionnalité de la DEMANDE, pas le processus (517 valeurs distinctes en v1,
 *  dont auto-diag, auto-relecture-pr, auto-diag-correctif-simple…). */
export const LLM_VERSION = 3;
export interface HdInfo { domain: string | null; title: string | null }
/** Ce que la lecture a relevé d'un transcript. `files` : chemin relatif → 'w' (écrit) ou 'r' (lu seulement). */
export interface Acc {
  offset: number; cwd: string | null; entrypoint: string | null; branch: string | null;
  firstUser: boolean; hd: string[]; files: Record<string, 'w' | 'r'>;
  /** Nature d'une session lancée par un script, lue dans son 1er message : diag, dev, relecture, recette, reprise
   *  (le lanceur), `automate:<script>` (autre script), null (session tapée par quelqu'un). */
  kind: string | null;
  /** titre de la session (dernier ai-title / custom-title), début du 1er message, nombre de messages tapés. */
  title: string | null; firstText: string; users: number;
}
/** Version de la forme de `acc` : un fichier plus ancien est relu depuis le début (les champs manquants n'y sont pas). */
export const ACC_VERSION = 2;
export interface TagFile {
  sessionId: string; rulesVersion: number | string; accVersion?: number; computedAt: number; transcriptLen: number; acc: Acc; hdPending: boolean;
  llm?: LlmResult | null; tags: Tag[];
}

const MAX_FILES = 3000;
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);

/** Section `tagger` absente : aucune règle, seuls les worktrees de Claude Code sont reconnus. */
export const EMPTY_CONFIG: TaggerConfig = {
  rulesVersion: '', hdDomains: [], outils: [], domaines: [], claudeDocs: {}, outilsSansDomaine: [], hdApi: '', maxBytesPerPass: 50 * 1024 * 1024,
  maxHdLookupsPerPass: 20, roots: [{ re: /^.*\/\.claude\/worktrees\/[^/]+\/(.+)$/, prefix: '' }], worktrees: [/\/\.claude\/worktrees\/([^/]+)/],
  ticketPattern: '', deepDirs: [], genericWords: [], context: 'un projet logiciel', usageFile: '',
};
/** Règles en service pour ce qui ne reçoit pas la configuration (lecture des lignes, chemins) : posées par runPass. */
let active: TaggerConfig = EMPTY_CONFIG;
let ticketRe: RegExp | null = null;
let ticketSlugRe: RegExp | null = null;
export function useConfig(cfg: TaggerConfig): void {
  active = cfg;
  ticketRe = cfg.ticketPattern ? new RegExp('\\b(?:' + cfg.ticketPattern + ')\\b', 'g') : null;
  // Dans un nom de worktree, la référence s'écrit en minuscules, tiret facultatif (« hd-123456 » ou « hd123456 »).
  ticketSlugRe = cfg.ticketPattern ? new RegExp('(^|-)(?:' + cfg.ticketPattern.toLowerCase().replace(/-/g, '-?') + ')(?=-|$)', 'g') : null;
}

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
const rules = (v: unknown): Rule[] => (Array.isArray(v) ? v.filter((r: any) => r && typeof r.v === 'string' && Array.isArray(r.re)).map((r: any) => ({ v: r.v, re: strs(r.re) })) : []);
/** %VAR% (et ~) d'un chemin, comme le serveur (modules.ts, expandPath). */
export function expandEnv(p: string, env: Record<string, string | undefined> = process.env): string {
  return p.replace(/^~(?=[\\/]|$)/, env.USERPROFILE ?? env.HOME ?? '~').replace(/%([A-Za-z0-9_]+)%/g, (m, k: string) => env[k] ?? env[k.toUpperCase()] ?? m);
}

/** Configuration de l'étiqueteur tirée du fichier du poste : section `tagger`, plus le motif des tickets
 *  (modules.tickets.pattern), le script de tickets et le dossier du lanceur (modules.launcher). Expression invalide ⇒
 *  erreur (le fichier est à corriger, pas à ignorer). */
export function taggerConfigFrom(raw: unknown, env: Record<string, string | undefined> = process.env): TaggerConfig {
  const root = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const t = (root.tagger && typeof root.tagger === 'object' ? root.tagger : null) as Record<string, any> | null;
  const mods = (root.modules && typeof root.modules === 'object' ? root.modules : {}) as Record<string, any>;
  const launcher = mods.launcher && typeof mods.launcher === 'object' ? mods.launcher : {};
  const ticketPattern = str(mods.tickets?.pattern);
  const launcherRoot = str(launcher.root) ? expandEnv(str(launcher.root), env) : '';
  const base: TaggerConfig = { ...EMPTY_CONFIG, ticketPattern, hdApi: str(launcher.ticketApi) ? expandEnv(str(launcher.ticketApi), env) : '', usageFile: launcherRoot ? join(launcherRoot, 'claude-usage.json') : '' };
  if (!t) return { ...base, rulesVersion: 'h:' + createHash('sha1').update(JSON.stringify([null, ticketPattern])).digest('hex').slice(0, 12) };
  const rx = (x: string, what: string): RegExp => { try { return new RegExp(x); } catch (e) { throw new Error(`tagger.${what} : expression invalide « ${x} » (${(e as Error).message})`); } };
  const roots: Root[] = Array.isArray(t.roots)
    ? t.roots.filter((r: any) => r && typeof r.re === 'string').map((r: any) => ({ re: rx(r.re, 'roots'), prefix: str(r.prefix) }))
    : base.roots;
  const worktrees = Array.isArray(t.worktrees) ? strs(t.worktrees).map((x) => rx(x, 'worktrees')) : base.worktrees;
  const cfg: TaggerConfig = {
    ...base,
    rulesVersion: 'h:' + createHash('sha1').update(JSON.stringify([t, ticketPattern])).digest('hex').slice(0, 12),
    hdDomains: strs(t.domains), outils: rules(t.tools), domaines: rules(t.topics),
    claudeDocs: t.docs && typeof t.docs === 'object' ? Object.fromEntries(Object.entries(t.docs).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {},
    outilsSansDomaine: strs(t.toolsWithoutTopic), roots, worktrees,
    deepDirs: strs(t.deepDirs).map((d) => d.toLowerCase()), genericWords: strs(t.genericWords).map((w) => w.toLowerCase()),
    context: str(t.context, base.context) || base.context,
    maxBytesPerPass: num(t.maxBytesPerPass, base.maxBytesPerPass), maxHdLookupsPerPass: num(t.maxHdLookupsPerPass, base.maxHdLookupsPerPass),
  };
  for (const k of ['llmModel', 'llmBatch', 'maxLlmBatchesPerPass', 'llmQuotaMaxPct', 'llmIdleMinutes'] as const) {
    const v = t[k]; if (k === 'llmModel' ? typeof v === 'string' && v : typeof v === 'number' && Number.isFinite(v)) (cfg as any)[k] = v;
  }
  for (const r of [...cfg.outils, ...cfg.domaines]) for (const x of r.re) rx(x, 'tools/topics');
  return cfg;
}

export const newAcc = (): Acc => ({ offset: 0, cwd: null, entrypoint: null, branch: null, firstUser: false, hd: [], files: {}, kind: null, title: null, firstText: '', users: 0 });

/** Chemin absolu → chemin relatif à la racine du dépôt (minuscules, « / »), ou null s'il ne dit rien du sujet
 *  (mémoire de Claude, %TEMP%, profil…). Racines : `tagger.roots`, dans l'ordre ; un relatif sous `.claude/` ne compte pas. */
export function relPath(p: string, cfg: TaggerConfig = active): string | null {
  const s = p.replace(/\\/g, '/').toLowerCase();
  for (const r of cfg.roots) {
    const m = r.re.exec(s);
    if (m && m[1] && !m[1].startsWith('.claude/')) return r.prefix + m[1];
  }
  return null;
}

/** Nom du worktree d'un chemin absolu : `tagger.worktrees`, dans l'ordre (groupe 1). */
export function worktreeOf(p: string, cfg: TaggerConfig = active): string | null {
  const s = p.replace(/\\/g, '/').toLowerCase();
  for (const re of cfg.worktrees) { const m = re.exec(s); if (m && m[1]) return m[1]; }
  return null;
}

/** Nom de worktree → fonctionnalité : sans ticket, lot ni suffixe de cadrage. null si rien de parlant ne reste. */
export function featureSlug(wt: string): string | null {
  let s = wt.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  if (ticketSlugRe) s = s.replace(ticketSlugRe, '');
  s = s.replace(/-(cadrage|lot-?\d+[a-z]?|recette|fix|hold|v\d+)(?=-|$)/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!s || s.length < 3 || isGeneric(s)) return null;
  return s.length > 40 ? s.slice(0, 40).replace(/-[^-]*$/, '') : s;
}

/** Nature d'une session lancée par un script, d'après l'en-tête que le script écrit dans son 1er message
 *  (« Session de DÉVELOPPEMENT automatique, SANS personne devant, lancée par `scripts/AutoDiagnostic/auto_dev.py` »). */
export function launchKind(body: string): string | null {
  const head = body.slice(0, 600);
  const by = /lanc[ée]e?\s+par\s+`?scripts[\\/]([A-Za-z]+)[\\/]([A-Za-z_]+)\.py/i.exec(head);
  const phase = /Session de (D[ÉE]VELOPPEMENT|RELECTURE|RECETTE|REPRISE)\b/i.exec(head)?.[1]?.toUpperCase();
  if (phase) return phase.startsWith('D') ? 'dev' : phase === 'RELECTURE' ? 'relecture' : phase === 'RECETTE' ? 'recette' : 'reprise';
  if (by && by[1]!.toLowerCase() === 'autodiagnostic') return by[2]!.toLowerCase() === 'auto_dev' ? 'dev' : by[2]!.toLowerCase() === 'auto_rework' ? 'reprise' : 'diag';
  if (by) return 'automate:' + by[2]!.toLowerCase().replace(/_/g, '-');
  return null;
}

/** Une ligne du transcript, sans la pile : chaque champ n'est cherché que tant qu'il manque. */
export function feedLine(acc: Acc, line: string): void {
  if (!line) return;
  const needHead = acc.cwd === null || acc.entrypoint === null;
  // Un message tapé (pas un résultat d'outil, qui est aussi « user ») : le 1er pour le sujet, les suivants comptés.
  const isUser = line.includes('"type":"user"') && !line.includes('"tool_result"') && (!acc.firstUser || acc.users < 99);
  const isTool = line.includes('"type":"tool_use"');
  const isTitle = line.startsWith('{"type":"ai-title"') || line.startsWith('{"type":"custom-title"');
  if (!needHead && !isUser && !isTool && !isTitle && (acc.branch !== null || !line.includes('"gitBranch"'))) return;
  let j: any; try { j = JSON.parse(line); } catch { return; }
  if (isTitle) { const t = j.customTitle ?? j.aiTitle; if (typeof t === 'string' && t.trim()) acc.title = t.trim().slice(0, 200); return; }
  if (isUser && acc.firstUser && j.type === 'user' && !j.isMeta && !j.isSidechain) { acc.users++; return; }
  if (acc.cwd === null && typeof j.cwd === 'string' && j.cwd) acc.cwd = j.cwd;
  if (acc.entrypoint === null && typeof j.entrypoint === 'string' && j.entrypoint) acc.entrypoint = j.entrypoint;
  if (acc.branch === null && typeof j.gitBranch === 'string' && j.gitBranch && j.gitBranch !== 'HEAD') acc.branch = j.gitBranch;
  if (isUser && j.type === 'user' && !j.isMeta && !j.isSidechain) {
    const c = j.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('\n') : '';
    // Commande « /skill args » : seuls les arguments disent le sujet (« /model » seul n'est pas le 1er message).
    const cmd = /<command-name>\/?([^<]*)<\/command-name>/.exec(text);
    const body = cmd ? (/<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? '') : text;
    if (body.trim() && !text.startsWith('<local-command')) {
      acc.firstUser = true; acc.users = 1;
      acc.firstText = body.replace(/\s+/g, ' ').trim().slice(0, 2000);
      acc.kind = launchKind(body);
      if (ticketRe) for (const m of body.slice(0, 8000).matchAll(ticketRe)) { const id = m[0]; if (!acc.hd.includes(id) && acc.hd.length < 3) acc.hd.push(id); }
    }
  }
  if (isTool && j.type === 'assistant' && Array.isArray(j.message?.content)) {
    for (const b of j.message.content) {
      if (b?.type !== 'tool_use') continue;
      const w = WRITE_TOOLS.has(b.name), r = READ_TOOLS.has(b.name);
      if (!w && !r) continue;
      for (const k of ['file_path', 'notebook_path', 'path']) {
        const p = b.input?.[k]; if (typeof p !== 'string' || !p) continue;
        const rel = relPath(p); if (!rel) continue;
        const key = rel + (worktreeOf(p) ? '\t' + worktreeOf(p) : '');
        if (w) acc.files[key] = 'w';
        else if (!(key in acc.files) && Object.keys(acc.files).length < MAX_FILES) acc.files[key] = 'r';
      }
    }
  }
}

interface Compiled { outils: { v: string; re: RegExp[] }[]; domaines: { v: string; re: RegExp[] }[]; docs: Map<string, string>; hdDomains: Set<string>; noDomain: Set<string> }
const compiledCache = new WeakMap<TaggerConfig, Compiled>();
function compile(cfg: TaggerConfig): Compiled {
  let c = compiledCache.get(cfg);
  if (!c) {
    const mk = (rs: Rule[]) => rs.map((r) => ({ v: r.v, re: r.re.map((x) => new RegExp(x)) }));
    c = { outils: mk(cfg.outils), domaines: mk(cfg.domaines), docs: new Map(Object.entries(cfg.claudeDocs).map(([k, v]) => [k.toLowerCase(), v])), hdDomains: new Set(cfg.hdDomains), noDomain: new Set(cfg.outilsSansDomaine ?? []) };
    compiledCache.set(cfg, c);
  }
  return c;
}

/** Outils et domaines d'un chemin relatif. Un fichier de mémoire `docs/claude/<Domaine>.md` vaut son domaine. */
export function classify(rel: string, cfg: TaggerConfig): { outils: string[]; domaines: string[] } {
  const c = compile(cfg);
  const outils = c.outils.filter((r) => r.re.some((x) => x.test(rel))).map((r) => r.v).slice(0, 1);   // un chemin = un outil (le 1er motif : ordre de la config)
  // Le code de l'outillage (lanceur, sessions-desk, infra) parle de tickets, d'appels… sans être du métier.
  if (outils.length && c.noDomain.has(outils[0]!)) return { outils, domaines: [] };
  const doc = /(?:^|\/)docs\/claude\/([a-z0-9]+)\.md$/.exec(rel);
  const domaines = doc ? (c.docs.has(doc[1]!) ? [c.docs.get(doc[1]!)!] : []) : c.domaines.filter((r) => r.re.some((x) => x.test(rel))).map((r) => r.v);
  return { outils, domaines };
}

/** Les classements par score, ex æquo départagés par l'ordre alphabétique (déterministe). */
function ranked(score: Map<string, number>): [string, number][] {
  return [...score.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Les tags d'une session, de ce que la lecture a relevé, du domaine HD de son ticket (null : inconnu) et de ce
 *  qu'a proposé le petit modèle (null : pas encore demandé). */
export function decide(acc: Acc, hdDomain: string | null, cfg: TaggerConfig, llm: LlmResult | null = null): Tag[] {
  const c = compile(cfg);
  const tags: Tag[] = [];
  // origine : qui a lancé la session. Un automate qui n'est pas le lanceur (statut Datadog, ménage de la mémoire) cite
  // des tickets en EXEMPLE dans son prompt : ses HD ne sont pas son sujet.
  const headless = acc.entrypoint === 'sdk-cli';
  const kind = acc.kind ?? (headless && acc.branch?.startsWith('auto-dev/') ? 'dev' : null);
  const automate = headless && (kind === null || kind.startsWith('automate:'));
  const origine = !headless ? 'interactive' : automate ? 'automate' : 'lanceur-' + kind;
  tags.push({ axis: 'origine', v: origine, src: acc.kind ? 'prompt' : 'entrypoint' });
  if (automate) { hdDomain = null; llm = null; }

  const dw = new Map<string, number>(), dr = new Map<string, number>(), ow = new Map<string, number>(), or = new Map<string, number>(), wts = new Map<string, number>();
  for (const [key, mode] of Object.entries(acc.files)) {
    const [rel, wt] = key.split('\t') as [string, string | undefined];
    const k = classify(rel, cfg);
    for (const d of k.domaines) (mode === 'w' ? dw : dr).set(d, ((mode === 'w' ? dw : dr).get(d) ?? 0) + 1);
    for (const o of k.outils) (mode === 'w' ? ow : or).set(o, ((mode === 'w' ? ow : or).get(o) ?? 0) + 1);
    if (wt) wts.set(wt, (wts.get(wt) ?? 0) + (mode === 'w' ? 3 : 1));
  }

  // domaine : celui de la demande HD prime ; puis les fichiers écrits (à défaut : lus, au moins 2). 2 au plus.
  // Le petit modèle ne donne un domaine qu'à une session qui n'en a aucun autrement.
  const dom: Tag[] = [];
  if (hdDomain && c.hdDomains.has(hdDomain) && hdDomain !== 'Autre') dom.push({ axis: 'domaine', v: hdDomain, src: 'hd' });
  const byFiles = dw.size ? ranked(dw) : ranked(dr).filter(([, n]) => n >= 2);
  const top = byFiles[0]?.[1] ?? 0;
  for (const [d, n] of byFiles) {
    if (dom.length >= 2) break;
    if (dom.some((t) => t.v === d)) continue;
    if (dom.length && (n < 2 || n * 2 < top)) break;    // un 2e domaine doit peser : au moins 2 fichiers et la moitié du 1er
    dom.push({ axis: 'domaine', v: d, src: dw.size ? 'fichiers' : 'lectures' });
  }
  if (!dom.length && llm?.domaine && c.hdDomains.has(llm.domaine) && llm.domaine !== 'Autre') dom.push({ axis: 'domaine', v: llm.domaine, src: 'ia' });
  tags.push(...dom);

  // outil : tout outil d'un fichier écrit ; à défaut, les 2 premiers d'au moins 3 fichiers lus. 4 au plus.
  const outils = ow.size ? ranked(ow) : ranked(or).filter(([, n]) => n >= 3).slice(0, 2);
  for (const [o] of outils.slice(0, 4)) tags.push({ axis: 'outil', v: o, src: ow.size ? 'fichiers' : 'lectures' });

  // fonction : ce qu'a proposé le petit modèle (2 au plus), puis le worktree où la session a le plus travaillé
  // (à défaut son dossier de départ, sa branche) ; 3 au plus. Un automate : le script qui l'a lancé.
  if (automate && kind) tags.push({ axis: 'fonction', v: kind.slice(9), src: 'script' });
  else {
    const fn: Tag[] = [];
    // Session du lanceur : son étape est déjà dite par l'origine ; « auto-… » ne dit rien de la fonctionnalité.
    const lanceur = origine.startsWith('lanceur-');
    for (const v of (llm?.fonction ?? []).slice(0, 2)) if (isFeatureSlug(v) && !(lanceur && v.startsWith('auto-')) && !fn.some((t) => t.v === v)) fn.push({ axis: 'fonction', v, src: 'ia' });
    const wt = ranked(wts)[0]?.[0] ?? (acc.cwd ? worktreeOf(acc.cwd) : null) ?? (acc.branch && !acc.branch.startsWith('auto-dev/') ? acc.branch.split('/').pop()! : null);
    const slug = wt ? featureSlug(wt) : null;
    if (slug && !fn.some((t) => t.v === slug)) fn.push({ axis: 'fonction', v: slug, src: 'worktree' });
    tags.push(...fn.slice(0, 3));
  }

  if (!automate) for (const h of acc.hd) tags.push({ axis: 'hd', v: h, src: 'prompt' });
  return tags;
}

/** Une fonctionnalité acceptable : kebab-case, 1 à 5 mots, 3 à 40 caractères. */
export const isFeatureSlug = (v: unknown): v is string => typeof v === 'string' && v.length >= 3 && v.length <= 40 && /^[a-z0-9]+(-[a-z0-9]+){0,4}$/.test(v) && !isGeneric(v);
/** Mots qui ne disent rien de la fonctionnalité (ou déjà dits par un autre axe : outil, origine). */
const GENERIC = /^(master|main|tmp|test|tests|wt|auto-dev|archive|fix|bug|bugs|front|back|api|server|serveur|docs|doc|feat|wip|spike|backend|frontend|session|sessions|lanceur|refactor|cadrage|recette|infra|demande|demande-sans-titre|demande-non-renseignee|sans-titre|non-renseigne|inconnu|divers|autre)$/;
/** Mot vide : la liste commune, plus `tagger.genericWords` du poste (nom du produit, d'un outil…). */
const isGeneric = (v: string): boolean => GENERIC.test(v) || active.genericWords.includes(v);

/** Lit `path` depuis `acc.offset` (au plus `budget` octets), jusqu'au dernier saut de ligne complet. Rend les octets lus. */
export function readFrom(path: string, acc: Acc, size: number, budget: number): number {
  if (size < acc.offset) { Object.assign(acc, newAcc()); }        // transcript réécrit (plus court) : on repart de zéro
  const end = Math.min(size, acc.offset + budget);
  if (end <= acc.offset) return 0;
  const fd = openSync(path, 'r');
  try {
    const CHUNK = 8 * 1024 * 1024; const buf = Buffer.alloc(CHUNK);
    let pos = acc.offset, rest = Buffer.alloc(0), done = 0;
    while (pos < end) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, end - pos), pos);
      if (n <= 0) break;
      pos += n; done += n;
      const data = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n);
      const last = data.lastIndexOf(10);
      if (last < 0) { rest = Buffer.from(data); continue; }
      for (const l of data.subarray(0, last).toString('utf8').split('\n')) feedLine(acc, l.replace(/\r$/, ''));
      acc.offset = pos - (data.length - last - 1);
      rest = Buffer.from(data.subarray(last + 1));
    }
    return done;
  } finally { closeSync(fd); }
}

// ───── Petit modèle ─────
export interface LlmItem { id: string; origine: string; titre: string | null; demande: string | null; message: string; dossiers: string[]; worktree: string | null }

/** Les dossiers (2 niveaux sous la racine du dépôt) des fichiers écrits, sinon lus : de quoi situer sans le contenu. */
export function topDirs(acc: Acc): string[] {
  const w = new Map<string, number>(), r = new Map<string, number>();
  for (const [key, mode] of Object.entries(acc.files)) {
    const rel = key.split('\t')[0]!; const parts = rel.split('/');
    const d = parts.slice(0, Math.min(parts.length - 1, active.deepDirs.some((p) => rel.startsWith(p)) ? 4 : 2)).join('/');
    if (d) (mode === 'w' ? w : r).set(d, ((mode === 'w' ? w : r).get(d) ?? 0) + 1);
  }
  return ranked(w.size ? w : r).slice(0, 12).map(([d]) => d);
}

/** La question posée au petit modèle pour un lot de sessions. */
export function llmPrompt(items: LlmItem[], known: string[], cfg: TaggerConfig): string {
  return [
    'Tu classes des sessions de travail d\'un développeur (Claude Code) sur ' + cfg.context + '.',
    'Pour CHAQUE session, propose :',
    '- "fonction" : 1 ou 2 identifiants de fonctionnalité en kebab-case, 1 à 4 mots, minuscules sans accents (ex. "power-dial", "bdc-relance", "tags-sessions"). RÉUTILISE en priorité un identifiant de la liste connue dès qu\'il désigne la même fonctionnalité ou une très proche (même écran, même flux, même chantier) ; n\'en crée un nouveau que si AUCUN ne convient. Le but est un vocabulaire court et stable pour retrouver les sessions d\'un même sujet. Chaque session se juge SEULE, sur son titre, sa demande et son message : ne recopie pas la réponse d\'une voisine. Pas de numéro de ticket, pas de mot vide ("fix", "bug", "session").',
    `- Session d'origine "lanceur-…" (diagnostic, développement, relecture, recette ou reprise AUTOMATIQUES d'une demande) : la fonctionnalité est celle de la DEMANDE (son titre), JAMAIS le processus du lanceur — pas de "auto-diag", "auto-dev", "relecture", "recette", "correctif", "reprise". Son message est surtout la consigne du lanceur : fie-toi à la demande. Si tu ne peux pas savoir la fonctionnalité, réponds "fonction": [] — JAMAIS un bouche-trou ("demande-sans-titre", "inconnu", "divers").`,
    '- "domaine" : un seul domaine métier parmi ' + JSON.stringify(cfg.hdDomains) + ', ou null si aucun ne convient vraiment. L\'OUTILLAGE n\'est PAS un domaine métier : le lanceur (diagnostic et développement automatiques), le poste de suivi des sessions (sessions-desk), l\'infra, la CI, la mémoire de Claude ⇒ null. "Autre" ⇒ null.',
    'Fonctionnalités déjà connues (les plus fréquentes d\'abord) : ' + JSON.stringify(known),
    'Réponds UNIQUEMENT par un objet JSON {"<id>": {"fonction": [...], "domaine": ... }, ...}, une entrée par session, sans texte autour.',
    'Sessions :',
    JSON.stringify(items),
  ].join('\n');
}

/** Réponse du modèle → résultats par session (identifiants filtrés, domaines hors liste écartés). */
export function parseLlm(raw: string, ids: string[], cfg: TaggerConfig, now: number, titles: Map<string, string | null>): Map<string, LlmResult> {
  const out = new Map<string, LlmResult>();
  const m = /\{[\s\S]*\}/.exec(raw); if (!m) return out;
  let j: any; try { j = JSON.parse(m[0]); } catch { return out; }
  if (!j || typeof j !== 'object') return out;
  const doms = new Set(cfg.hdDomains);
  for (const id of ids) {
    const e = j[id]; if (!e || typeof e !== 'object') continue;
    const fonction = (Array.isArray(e.fonction) ? e.fonction : [e.fonction]).filter(isFeatureSlug).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i).slice(0, 2);
    const domaine = typeof e.domaine === 'string' && doms.has(e.domaine) ? e.domaine : null;
    out.set(id, { at: now, title: titles.get(id) ?? null, fonction, domaine, v: LLM_VERSION });
  }
  return out;
}

/** Quota de la semaine le plus haut des comptes mesurés par le lanceur (claude-usage.json), ou null s'il est inconnu.
 *  Avec `model` (id du modèle appelé, « claude-fable-5-2 »), la limite propre à ce modèle compte aussi (limitsJson,
 *  « Fable ») : elle peut saturer avant la limite globale. Les limites des autres modèles ne comptent pas. */
export function weeklyQuotaPct(usagePath: string, model?: string): number | null {
  try {
    const j = JSON.parse(readFileSync(usagePath, 'utf8')) as Record<string, { weeklyPct?: unknown; limitsJson?: unknown }>;
    const v: unknown[] = Object.values(j).map((a) => a?.weeklyPct);
    const id = (model ?? '').toLowerCase();
    if (id) for (const a of Object.values(j)) {
      try {
        const p = JSON.parse(String(a?.limitsJson ?? 'null')) as unknown;
        for (const x of Array.isArray(p) ? p : []) {
          const l = (x ?? {}) as { percent?: unknown; scope?: { model?: { display_name?: unknown } } | null };
          const name = l.scope?.model?.display_name;
          if (typeof name === 'string' && name && id.includes(name.toLowerCase())) v.push(l.percent);
        }
      } catch { /* limitsJson illisible (« None ») : seule la limite globale compte */ }
    }
    const n = v.filter((x): x is number => typeof x === 'number');
    return n.length ? Math.max(...n) : null;
  } catch { return null; }
}

/** `claude -p` sur le petit modèle : une question, sans outil, sans MCP, sans session enregistrée (comme
 *  `_common.ask_small_model` du lanceur). Rend le texte de la réponse, undefined en cas d'échec. */
export function claudeAsk(exe: string, model: string): (prompt: string) => string | undefined {
  return (prompt) => {
    const env: Record<string, string | undefined> = { ...process.env, PYTHONIOENCODING: 'utf-8' };
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
    try {
      const out = execFileSync(exe, ['-p', '--model', model, '--tools', '', '--strict-mcp-config', '--no-session-persistence',
        '--output-format', 'json', '--max-budget-usd', '0.50', '--max-turns', '1'],
      { input: prompt, encoding: 'utf8', timeout: 240000, windowsHide: true, env, maxBuffer: 16 * 1024 * 1024 });
      const j = JSON.parse(out);
      return j?.is_error ? undefined : typeof j?.result === 'string' ? j.result : undefined;
    } catch { return undefined; }
  };
}

export interface PassOptions {
  projectsDir: string; outDir: string; cfg: TaggerConfig; now?: number;
  /** Domaine et titre HD d'un ticket (« 990033 ») ; undefined = indisponible (réessayé à la passe suivante). */
  hdLookup: (id: string) => HdInfo | null | undefined;
  /** Petit modèle ; absent = pas de proposition à cette passe (quota, essai à blanc). */
  llm?: ((prompt: string) => string | undefined) | undefined;
}
export interface PassResult {
  sessions: number; updated: number; skipped: number; bytes: number; hdLookups: number; pending: number; purged: number; budgetHit: boolean;
  llmCalls: number; llmTagged: number; llmFailed: number; llmWaiting: number;
}

const HD_TTL = 7 * 86400000, HD_NULL_TTL = 86400000;
type HdEntry = { domain: string | null; title?: string | null; at: number };

/** Une passe : chaque transcript changé (ou en attente d'un domaine HD) est relu depuis son dernier octet et re-tagué ;
 *  puis les sessions qui attendent une proposition du petit modèle la reçoivent, par lots. */
export function runPass(o: PassOptions): PassResult {
  const now = o.now ?? Date.now();
  useConfig(o.cfg);
  const res: PassResult = { sessions: 0, updated: 0, skipped: 0, bytes: 0, hdLookups: 0, pending: 0, purged: 0, budgetHit: false, llmCalls: 0, llmTagged: 0, llmFailed: 0, llmWaiting: 0 };
  mkdirSync(o.outDir, { recursive: true });
  const cachePath = join(o.outDir, '_hd-domains.json');
  let hdCache: Record<string, HdEntry> = {};
  try { hdCache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { /* premier passage */ }
  let cacheDirty = false;
  // Une entrée sans `title` est relue pour avoir le titre de la demande, dans le budget de la passe.
  const hdOf = (hd: string): { info: HdInfo; pending: boolean } => {
    const id = hd.replace(/^[^0-9]*/, '') || hd; const e = hdCache[id];
    const cached: HdInfo = { domain: e?.domain ?? null, title: e?.title ?? null };
    if (e && 'title' in e && now - e.at < (e.domain ? HD_TTL : HD_NULL_TTL)) return { info: cached, pending: false };
    if (res.hdLookups >= o.cfg.maxHdLookupsPerPass) return { info: cached, pending: !e };
    res.hdLookups++;
    const d = o.hdLookup(id);
    if (d === undefined) return { info: cached, pending: !e };
    hdCache[id] = { domain: d?.domain ?? null, title: d?.title ?? null, at: now }; cacheDirty = true;
    return { info: { domain: d?.domain ?? null, title: d?.title ?? null }, pending: false };
  };
  const write = (out: string, tf: TagFile): void => { writeFileSync(out + '.tmp', JSON.stringify(tf)); renameSync(out + '.tmp', out); };

  // Transcripts du plus récent au plus ancien : le rattrapage sert d'abord ce qu'on cherche le plus.
  const files: { id: string; path: string; size: number; mtime: number }[] = [];
  let projects: string[]; try { projects = readdirSync(o.projectsDir); } catch { return res; }
  for (const p of projects) {
    const dir = join(o.projectsDir, p);
    let names: string[]; try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      try { const st = statSync(join(dir, n)); if (st.isFile()) files.push({ id: n.slice(0, -6), path: join(dir, n), size: st.size, mtime: st.mtimeMs }); } catch { /* disparu */ }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  res.sessions = files.length;
  const ids = new Set(files.map((f) => f.id));
  const known = new Map<string, number>();
  const waiting: { out: string; tf: TagFile; hdDomain: string | null; hdTitle: string | null }[] = [];
  const idleMs = (o.cfg.llmIdleMinutes ?? 15) * 60000;

  for (const f of files) {
    if (!/^[0-9a-f-]{36}$/i.test(f.id)) continue;
    const out = join(o.outDir, f.id + '.json');
    let prev: TagFile | null = null;
    try { prev = JSON.parse(readFileSync(out, 'utf8')); } catch { /* jamais tagué */ }
    if (prev && prev.accVersion !== ACC_VERSION) prev = { ...prev, acc: newAcc(), llm: prev.llm ?? null };   // forme ancienne : relire
    let tf: TagFile, hdDomain: string | null = null, hdTitle: string | null = null;
    // v3 : la demande HD dont le titre n'est pas encore connu (ancien cache, budget épuisé) retient la question au
    // petit modèle — sans lui, une session du lanceur n'offre que la consigne du lanceur (« demande-sans-titre »).
    const titleKnown = (hd: string): boolean => { const e = hdCache[hd.slice(3)]; return !!e && 'title' in e; };
    if (prev && prev.transcriptLen === f.size && prev.rulesVersion === o.cfg.rulesVersion && !prev.hdPending && prev.acc.offset === f.size) {
      res.skipped++; tf = prev;
      if (tf.acc.hd.length) {
        // Par hdOf, pas le cache seul : une session inchangée dont la demande n'a pas de titre en cache le fait relire.
        const r = hdOf(tf.acc.hd[0]!); hdDomain = r.info.domain; hdTitle = r.info.title;
        const tags = decide(tf.acc, hdDomain, o.cfg, tf.llm);
        if (JSON.stringify(tags) !== JSON.stringify(tf.tags)) { tf = { ...tf, tags, computedAt: now }; write(out, tf); }
      }
    } else {
      const left = o.cfg.maxBytesPerPass - res.bytes;
      const acc = prev && prev.acc ? prev.acc : newAcc();
      let cut = false;                                 // lecture arrêtée par le budget : à reprendre à la passe suivante
      if (acc.offset !== f.size) {
        if (left <= 0) { res.budgetHit = true; continue; }
        cut = Math.max(acc.offset, 0) + left < f.size && acc.offset <= f.size;
        res.bytes += readFrom(f.path, acc, f.size, left);
        if (cut) res.budgetHit = true;
      }
      let pending = false;
      if (acc.hd.length) { const r = hdOf(acc.hd[0]!); hdDomain = r.info.domain; hdTitle = r.info.title; pending = r.pending; }
      if (pending) res.pending++;
      const llm = prev?.llm ?? null;
      tf = { sessionId: f.id, rulesVersion: o.cfg.rulesVersion, accVersion: ACC_VERSION, computedAt: now, transcriptLen: cut ? -1 : f.size, acc, hdPending: pending, llm, tags: decide(acc, hdDomain, o.cfg, llm) };
      write(out, tf);
      res.updated++;
    }
    for (const t of tf.tags) if (t.axis === 'fonction' && t.src !== 'script' && isFeatureSlug(t.v)) known.set(t.v, (known.get(t.v) ?? 0) + 1);
    // En attente d'une proposition : ni automate, un 1er message lu, jamais demandée ou titre changé depuis, et la
    // session a un titre ou ne bouge plus (une session sans tête n'a pas de titre : on attend qu'elle ait fini).
    const automate = tf.tags.some((t) => t.axis === 'origine' && t.v === 'automate');
    if (!automate && tf.acc.firstUser && tf.transcriptLen !== -1 && (!tf.llm || tf.llm.title !== tf.acc.title || (tf.llm.v ?? 1) !== LLM_VERSION) && (tf.acc.title || now - f.mtime > idleMs) && (!tf.acc.hd.length || titleKnown(tf.acc.hd[0]!))) {
      waiting.push({ out, tf, hdDomain, hdTitle });
    }
  }
  res.llmWaiting = waiting.length;

  // Petit modèle : par lots, les plus récentes d'abord, plafonné par passe.
  if (o.llm && waiting.length) {
    const size = Math.max(1, o.cfg.llmBatch ?? 20), maxCalls = o.cfg.maxLlmBatchesPerPass ?? 5;
    // Une valeur portée par une seule session n'est pas (encore) du vocabulaire : la proposer entretient la traîne.
    const knownList = [...known.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 150).map(([v]) => v);
    for (let i = 0; i < waiting.length && res.llmCalls < maxCalls; i += size) {
      const batch = waiting.slice(i, i + size);
      // Clés courtes (s1, s2…) : avec des UUID presque semblables, le modèle attribuait une réponse à la mauvaise session.
      const key = (k: number) => 's' + (k + 1);
      const items: LlmItem[] = batch.map((w, k) => ({
        id: key(k), origine: w.tf.tags.find((t) => t.axis === 'origine')?.v ?? 'interactive', titre: w.tf.acc.title, demande: w.hdTitle ? `${w.tf.acc.hd[0]} — ${w.hdTitle}` : null,
        message: w.tf.acc.firstText, dossiers: topDirs(w.tf.acc), worktree: w.tf.tags.find((t) => t.axis === 'fonction' && t.src === 'worktree')?.v ?? null,
      }));
      res.llmCalls++;
      const raw = o.llm(llmPrompt(items, knownList, o.cfg));
      if (raw === undefined) { res.llmFailed += batch.length; continue; }
      const got = parseLlm(raw, items.map((x) => x.id), o.cfg, now, new Map(batch.map((w, k) => [key(k), w.tf.acc.title])));
      for (const [k, w] of batch.entries()) {
        // Sans réponse pour elle : notée « demandée, rien » (pas de nouvelle question tant que le titre ne change pas).
        const llm = got.get(key(k)) ?? { at: now, title: w.tf.acc.title, fonction: [], domaine: null, v: LLM_VERSION };
        if (got.has(key(k))) res.llmTagged++; else res.llmFailed++;
        w.tf.llm = llm; w.tf.computedAt = now; w.tf.tags = decide(w.tf.acc, w.hdDomain, o.cfg, llm);
        write(w.out, w.tf);
      }
    }
  }

  // Rétention : un fichier de tags dont le transcript a disparu ne sert plus (la session ne se rouvre pas).
  if (files.length) {
    for (const n of readdirSync(o.outDir)) {
      if (!n.endsWith('.json') || n.startsWith('_')) continue;
      if (!ids.has(n.slice(0, -5))) { rmSync(join(o.outDir, n), { force: true }); res.purged++; }
    }
  }
  if (cacheDirty) { writeFileSync(cachePath + '.tmp', JSON.stringify(hdCache)); renameSync(cachePath + '.tmp', cachePath); }
  // Vocabulaire des axes fermés, pour le serveur qui lit les tags sans connaître les règles (state.ts, loadVocab).
  try {
    const vocab = JSON.stringify({ domaines: o.cfg.hdDomains.filter((d) => d !== 'Autre'), outils: o.cfg.outils.map((r) => r.v) });
    const vp = join(o.outDir, '_vocab.json'); let old = ''; try { old = readFileSync(vp, 'utf8'); } catch { /* premier passage */ }
    if (old !== vocab) { writeFileSync(vp + '.tmp', vocab); renameSync(vp + '.tmp', vp); }
  } catch { /* facultatif : le serveur retombe sur la section tagger de son fichier de configuration */ }
  return res;
}

/** Domaine et titre d'un ticket par le script de tickets du lanceur (`python <ticketApi> ticket <id>`, lecture seule) :
 *  JSON avec `title` et `internalRequest.domain`. */
export function hdApiLookup(hdApi: string): (id: string) => HdInfo | null | undefined {
  return (id) => {
    try {
      const out = execFileSync('python', [hdApi, 'ticket', id], { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      const j = JSON.parse(out);
      const d = j?.internalRequest?.domain, t = j?.title;
      return { domain: typeof d === 'string' && d ? d : null, title: typeof t === 'string' && t ? t.slice(0, 200) : null };
    } catch {
      // Ticket introuvable, hors périmètre, réseau : null, mémorisé UN jour (sinon un ticket supprimé reprendrait le
      // budget de chaque passe). Script absent : la passe n'appelle pas cette fonction (main).
      return null;
    }
  };
}

function main(argv: string[]): number {
  const arg = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  // Le fichier de configuration du poste, comme le serveur : --config, puis SD_CONFIG, puis ~/.claude/sessions-desk/config.json.
  const file = arg('--config') ?? process.env.SD_CONFIG ?? join(home, '.claude', 'sessions-desk', 'config.json');
  let raw: unknown = {};
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    try { raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch (e) {
      console.error(`étiqueteur arrêté : ${file} est illisible (${(e as Error).message})`); return 1;
    }
  }
  let cfg: TaggerConfig;
  try { cfg = taggerConfigFrom(raw); } catch (e) { console.error(`étiqueteur arrêté : ${(e as Error).message} (${file})`); return 1; }
  if (process.env.SD_TAGGER_TICKET_API) cfg.hdApi = process.env.SD_TAGGER_TICKET_API;
  const claude = join(home, '.claude');
  const outDir = arg('--out') ?? join(claude, 'state', 'session-tags');
  mkdirSync(outDir, { recursive: true });
  // Une passe à la fois : la tâche planifiée peut se relancer pendant un long rattrapage.
  const lock = join(outDir, '_tagger.lock');
  try {
    const st = statSync(lock);
    if (Date.now() - st.mtimeMs < 30 * 60000) { console.log('passe déjà en cours'); return 0; }
  } catch { /* pas de verrou */ }
  writeFileSync(lock, String(process.pid));
  const t0 = Date.now();
  try {
    const hdLookup = cfg.hdApi && existsSync(cfg.hdApi) && !argv.includes('--no-hd') ? hdApiLookup(cfg.hdApi) : () => undefined;
    // Petit modèle : ni en essai à blanc (--no-llm), ni quand le quota de la semaine atteint le seuil.
    const llmModel = cfg.llmModel ?? 'claude-haiku-5-5';
    const quota = cfg.usageFile ? weeklyQuotaPct(cfg.usageFile, llmModel) : null;
    const llmOff = argv.includes('--no-llm') ? 'désactivé' : quota !== null && quota >= (cfg.llmQuotaMaxPct ?? 90) ? `quota ${quota} %` : null;
    const exe = [join(home, '.local', 'bin', 'claude.exe'), join(home, '.local', 'bin', 'claude')].find((p) => existsSync(p)) ?? 'claude';
    const llm = llmOff ? undefined : claudeAsk(exe, llmModel);
    const r = runPass({ projectsDir: arg('--projects') ?? join(claude, 'projects'), outDir, cfg, hdLookup, llm });
    const line = JSON.stringify({ at: t0, ms: Date.now() - t0, rulesVersion: cfg.rulesVersion, ...r, ...(llmOff ? { llmOff } : {}) });
    console.log(line);
    try { appendFileSync(join(outDir, '_tagger.log'), line + '\n'); } catch { /* journal facultatif */ }
    return 0;
  } finally { rmSync(lock, { force: true }); }
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2));
