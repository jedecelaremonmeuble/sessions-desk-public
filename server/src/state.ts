// État des sessions — portage de la partie « lecture des données » de legacy/sessions-dashboard.ps1
// (Get-SessionMeta, Update-Prompts, Get-OpenSessions, Get-BusyFix, Get-CachedSuggestion, Save-OpenSeen,
// Get-RebootInfo, Write-StatusChanges, Get-State, Get-Closed, Get-NewFolders, favoris, masquées, « vu »).
// Chaque fonction garde le nom de son original en commentaire ; les règles invisibles (ordre, troncatures,
// caches) sont couvertes par les tests de parité (test/parity/).
import { readdirSync, rmSync, statSync } from 'node:fs';
import { uptime } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.ts';
import type { DriverClient } from './driver.ts';
import { modulesView } from './modules.ts';
import { lastNewsAt } from './quiet.ts';
import { pendingQueue, type QueuedPrompt } from './queued.ts';
import { activeAccountUuid, markActiveAccount, readClaudeUsage, promptSuggestionSetting } from './usage.ts';
import { isProbeCwd } from './usage-probe.ts';
import { AskJudge, claudeAskAsync } from './asks-judge.ts';
import { T } from './i18n.ts';
import { Drafts } from './drafts.ts';
import {
  addContent, GUID, ieq, imatch, isDir, isFile, leaf, mtimeMs, netTrim, nowMs, parent, psString, readJson, readTail,
  setContent, setContentAtomic, splitPathParent, transcriptCreatedAt,
} from './util.ts';

export interface Meta {
  path: string | null; len: number; title: string | null; pr: number | null; prUrl: string | null; cwd: string | null;
  reply: string | null; tokens: number | null; model: string | null; wt: string | null; recette: boolean;
  /** Messages tapés pendant que la session travaille, pas encore pris (queued.ts). */
  queued: QueuedPrompt[];
  /** Derniers tours sans nouveauté (quiet.ts) : fin du dernier tour qui comptait ; null si le dernier tour compte. */
  quiet: { at: number; why: string } | null;
  /** Création de la session (transcriptCreatedAt) : lue une fois, quand le transcript est trouvé. */
  createdAt: number | null;
}
export interface Prompt { at: unknown; text: string }
export type Spin = { verb: string; tokens: string | null };
export type Session = Record<string, unknown> & {
  pid: number; sessionId: string; title: string | null; status: string; headless: boolean; gitDir: string;
  git: GitInfo | null; prInfo: PrInfo | null; statusSince: number; reply: string | null; name: unknown; cwd: unknown;
};
export type GitInfo = Record<string, unknown> & { worktree?: boolean; nFiles?: number; upstream?: string | null; ahead?: number; merged?: boolean; top?: string };
export type PrInfo = Record<string, unknown> & { state?: string };

const W = String.raw`\p{L}\p{Mn}\p{Nd}\p{Pc}`;
// Chemin de worktree dans le JSON d'un transcript : « C:\\code\\…\\.claude\\worktrees\\x », « C:/…/.claude/worktrees/x »
// ou « /c/Sources/…/.claude/worktrees/x ». Groupes : lecteur (forme C:), lecteur (forme /c), milieu, nom.
const WT_RX = new RegExp(String.raw`(?:(?<![${W}.-])([a-z]):|(?<![${W}/.:-])/([a-z])(?=/))((?:(?:\\\\|/)[${W}.-]+)*?)(?:\\\\|/)\.claude(?:\\\\|/)worktrees(?:\\\\|/)([${W}.-]+)`, 'giu');
const MODEL_RX = /"model":"(claude-[A-Za-z0-9.\-\[\]]+)"/i;
const RECETTE_RX = /dev-deploy\.yml|branch-env\.yml|"skill":"(dev-deploy|deploy-dev|branch-env|brenv)"/i;
const CWD_RX = /"cwd":"([A-Za-z]:(?:[^"\\]|\\\\)*)"/i;

/** Ordre de Get-ChildItem sur NTFS : noms comparés en majuscules. */
export function ntfsSort(names: string[]): string[] {
  return names.sort((a, b) => { const x = a.toUpperCase(), y = b.toUpperCase(); return x < y ? -1 : x > y ? 1 : 0; });
}
function listDir(dir: string): string[] { try { return ntfsSort(readdirSync(dir)); } catch { return []; } }

export interface SessionTag { axis: string; v: string; src: string }
const TAG_AXES = new Set(['origine', 'domaine', 'outil', 'fonction', 'hd']);
/** Get-SessionTags : `tags` d'un fichier de l'étiqueteur, filtrés (axe connu, valeur texte de 1 à 60 caractères,
 *  20 au plus) ; null si ce n'est pas un tableau ou qu'il ne reste rien. */
export function cleanTags(raw: unknown): SessionTag[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SessionTag[] = [];
  for (const t of raw) {
    if (out.length >= 20) break;
    if (t === null || typeof t !== 'object' || Array.isArray(t)) continue;
    const { axis, v, src } = t as Record<string, unknown>;
    if (typeof axis !== 'string' || !TAG_AXES.has(axis) || typeof v !== 'string' || v.length < 1 || v.length > 60) continue;
    out.push({ axis, v, src: typeof src === 'string' ? src : '' });
  }
  return out.length ? out : null;
}

// ───── Correction à la main (lot 3) — même règle que le .ps1 (ConvertTo-TagList, Get-SessionTags, Set-SessionTag) ─────
export interface ManualTags { add: { axis: string; v: string }[]; remove: { axis: string; v: string }[] }
const TAG_EDITABLE = new Set(['domaine', 'outil', 'fonction']);
function tagList(raw: unknown): { axis: string; v: string }[] {
  const out: { axis: string; v: string }[] = [];
  for (const t of Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]) {
    if (out.length >= 20) break;
    if (t === null || typeof t !== 'object') continue;
    const { axis, v } = t as Record<string, unknown>;
    if (typeof axis !== 'string' || !TAG_EDITABLE.has(axis) || typeof v !== 'string' || v.length < 1 || v.length > 60) continue;
    out.push({ axis, v });
  }
  return out;
}
export function parseManual(j: unknown): Map<string, ManualTags> {
  const m = new Map<string, ManualTags>();
  if (!j || typeof j !== 'object' || Array.isArray(j)) return m;
  for (const [k, e] of Object.entries(j as Record<string, unknown>)) {
    if (!GUID.test(k)) continue;
    const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
    m.set(k, { add: tagList(o.add), remove: tagList(o.remove) });
  }
  return m;
}
/** Le manuel par-dessus l'automatique : retirés écartés, ajoutés à la fin (src « manuel »), sans doublon. */
export function applyManual(auto: SessionTag[] | null, m: ManualTags | undefined): SessionTag[] | null {
  if (!m) return auto;
  const rm = new Set(m.remove.map((t) => t.axis + '\t' + t.v));
  const seen = new Set<string>(); const out: SessionTag[] = [];
  for (const t of auto ?? []) { const k = t.axis + '\t' + t.v; if (rm.has(k)) continue; seen.add(k); out.push(t); }
  for (const t of m.add) { const k = t.axis + '\t' + t.v; if (!seen.has(k)) { seen.add(k); out.push({ axis: t.axis, v: t.v, src: 'manuel' }); } }
  return out.length ? out : null;
}
export function checkTag(id: string, axis: string, v: string, vocab: { domaines: string[]; outils: string[] }): string | null {
  if (!GUID.test(id)) return T('session inconnue', 'unknown session');
  if (!TAG_EDITABLE.has(axis)) return T('axe non modifiable (domaine, outil ou fonction)', 'axis not editable (domaine, outil or fonction)');
  if (axis === 'domaine' && !vocab.domaines.includes(v)) return T('domaine hors liste', 'domain not in the list');
  if (axis === 'outil' && !vocab.outils.includes(v)) return T('outil hors liste', 'tool not in the list');
  if (axis === 'fonction' && (v.length < 3 || v.length > 40 || !/^[a-z0-9]+(-[a-z0-9]+){0,4}$/.test(v))) return T('fonction : 1 à 5 mots en minuscules reliés par « - », 3 à 40 caractères', 'function: 1 to 5 lowercase words joined by "-", 3 to 40 characters');
  return null;
}
/** Valeurs admises pour les axes fermés. L'étiqueteur n'est pas une pièce du serveur : il publie son vocabulaire dans
 *  `<tags>/_vocab.json` ({ domaines: [...], outils: [...] }) à côté des tags qu'il écrit. À défaut — il n'a pas encore
 *  tourné — la section `tagger` du fichier de configuration (`fallback`). Ni l'un ni l'autre : aucun axe fermé admis. */
export function loadVocab(tagsDir?: string, fallback: { domaines: string[]; outils: string[] } = { domaines: [], outils: [] }): { domaines: string[]; outils: string[] } {
  if (tagsDir) {
    const v = readJson(join(tagsDir, '_vocab.json')) as { domaines?: unknown; outils?: unknown } | undefined;
    const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 60) : []);
    if (v && typeof v === 'object' && (Array.isArray(v.domaines) || Array.isArray(v.outils))) return { domaines: list(v.domaines), outils: list(v.outils) };
  }
  return { domaines: [...fallback.domaines], outils: [...fallback.outils] };
}

/** Dossier proposé par « Nouvelle session » ; `declared` : écrit dans `newSession.folders` de config.json. */
export interface NewFolder { path: string; last: number; count: number; declared?: true }
/** Fusionne les dossiers récents et les dossiers déclarés : un déclaré déjà récent garde sa place (et sa date),
 *  un déclaré sans session récente vient après les récents, dans l'ordre du fichier. Un dossier disparu n'est
 *  jamais proposé. */
export function withDeclaredFolders(recent: { path: string; last: number; count: number }[], declared: string[], exists: (p: string) => boolean): NewFolder[] {
  const decl = new Set(declared.map((p) => p.toLowerCase()));
  const out: NewFolder[] = recent.filter((e) => exists(e.path)).sort((a, b) => b.last - a.last)
    .map((e) => ({ path: e.path, last: e.last, count: e.count, ...(decl.has(e.path.toLowerCase()) ? { declared: true as const } : {}) }));
  const have = new Set(out.map((e) => e.path.toLowerCase()));
  for (const p of declared) if (!have.has(p.toLowerCase()) && exists(p)) { have.add(p.toLowerCase()); out.push({ path: p, last: 0, count: 0, declared: true }); }
  return out;
}

export class Dashboard {
  readonly cfg: Config;
  readonly driver: DriverClient;
  /** Fins de tour du hook « Stop » (sessionId → ms) — Front.Stops. */
  readonly stops = new Map<string, number>();
  readonly metaCache = new Map<string, Meta>();
  readonly wtExists = new Set<string>();
  prompts = new Map<string, Prompt[]>();
  histLen = -1;
  seen = new Map<string, number>();
  favs = new Set<string>();
  hidden = new Set<string>();
  notifs: Record<string, unknown>[] = [];
  prState: Record<string, PrInfo> = {};
  gitState: Record<string, GitInfo> = {};
  screenChk = new Map<string, { mark: number; at: number; idleSince: number; logged: boolean; hookRead: boolean; spin?: Spin | null }>();
  sugCache = new Map<string, { mark: number; at: number; text: string | null }>();
  openSeen = new Map<string, number>();
  openSaved = 0;
  reboot: { at: number; ids: string[] } | null = null;
  rebootView: { at: number; value: unknown } = { at: 0, value: null };
  lastStatus = new Map<string, string>();
  closedScan: { at: number; files: { id: string; path: string; mtime: number }[] } = { at: 0, files: [] };
  readonly bootMs: number;
  /** Juge « attend l'utilisateur ? » (asks-judge.ts) : serveur en écriture (8765 ou 8767 --allow-write), hors --no-background (tests). */
  askJudge: AskJudge | null = null;
  /** Brouillons de nouvelle session (drafts.ts) : enregistrés sans être lancés. */
  readonly drafts: Drafts;
  #stamps = new Map<string, number>();

  constructor(cfg: Config, driver: DriverClient) {
    this.cfg = cfg;
    this.driver = driver;
    // [Environment]::TickCount64 : millisecondes depuis le démarrage de Windows.
    this.bootMs = Date.now() - Math.round(uptime() * 1000);
    this.reloadSeen(true); this.reloadFavs(true); this.reloadHidden(true); this.reloadTagsManual(true);
    this.notifs = this.readNotifsFile();
    this.drafts = new Drafts(this.sf('sessions-new-drafts.json'));
    this.initReboot();
    if (cfg.allowWrite && !cfg.noBackground && process.env.SD_ASK_JUDGE !== '0')
      this.askJudge = new AskJudge(this.sf('sessions-ask-verdicts.json'), claudeAskAsync(process.env.SD_CLAUDE_EXE ?? 'claude', process.env.SD_ASK_MODEL ?? 'claude-haiku-5-5'));
  }

  // ───── chemins ─────
  f(rel: string): string { return join(this.cfg.claude, rel); }
  get stateDir(): string { return this.f('state'); }
  sf(name: string): string { return join(this.stateDir, name); }
  get sessionsDir(): string { return this.f('sessions'); }
  get projectsDir(): string { return this.f('projects'); }

  /** Relu quand le fichier change (fichiers partagés avec le .ps1, qui fait de même : chacun suit les écritures de l'autre). */
  #changed(path: string, force = false): boolean {
    const m = mtimeMs(path);
    if (!force && this.#stamps.get(path) === m) return false;
    this.#stamps.set(path, m);
    return true;
  }

  // ───── « vu », favoris, masquées ─────
  reloadSeen(force = false): void {
    const p = this.sf('sessions-dashboard-seen.json');
    if (!this.#changed(p, force)) return;
    const j = readJson(p);
    const m = new Map<string, number>();
    if (j && typeof j === 'object' && !Array.isArray(j)) for (const [k, v] of Object.entries(j)) m.set(k, Number(v) || 0);
    this.seen = m;
  }
  /** Set-Seen */
  setSeen(ids: unknown[]): void {
    const now = nowMs();
    for (const id of ids) if (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) this.seen.set(id, now);
    if (!this.cfg.allowWrite) return;
    try { const p = this.sf('sessions-dashboard-seen.json'); setContent(p, JSON.stringify(Object.fromEntries(this.seen))); this.#changed(p, true); } catch { /* comme le .ps1 */ }
  }
  reloadFavs(force = false): void {
    const p = this.sf('sessions-dashboard-favs.json');
    if (!this.#changed(p, force)) return;
    const j = readJson(p);
    this.favs = new Set((Array.isArray(j) ? j : j === undefined || j === null ? [] : [j]).map((x) => psString(x)));
  }
  /** Set-Fav */
  setFav(id: string, on: boolean): void {
    if (!GUID.test(id)) return;
    if (on) this.favs.add(id); else this.favs.delete(id);
    try { const p = this.sf('sessions-dashboard-favs.json'); setContent(p, JSON.stringify([...this.favs])); this.#changed(p, true); } catch { /* idem */ }
  }
  reloadHidden(force = false): void {
    const p = this.sf('sessions-dashboard-hidden.json');
    if (!this.#changed(p, force)) return;
    const j = readJson(p);
    this.hidden = new Set((Array.isArray(j) ? j : j === undefined || j === null ? [] : [j]).map((x) => psString(x)));
  }
  /** Set-Hidden */
  setHidden(ids: unknown[], on: boolean): number {
    let n = 0;
    for (const raw of ids) {
      const id = psString(raw);
      if (!GUID.test(id)) continue;
      if (on) { if (!this.hidden.has(id)) { this.hidden.add(id); n++; } } else if (this.hidden.delete(id)) n++;
    }
    try { const p = this.sf('sessions-dashboard-hidden.json'); setContent(p, JSON.stringify([...this.hidden])); this.#changed(p, true); } catch { /* idem */ }
    return n;
  }
  readNotifsFile(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const l of readTail(this.sf('sessions-dashboard-notifs.jsonl'), 64 * 1024)) { try { out.push(JSON.parse(l)); } catch { /* ligne cassée */ } }
    return out;
  }

  // ───── Get-SessionTags ─────
  // Écrits par l'étiqueteur (tagger.ts, tâche planifiée) dans state/session-tags/<id>.json ; relus quand le fichier change.
  tagsCache = new Map<string, { k: string; tags: SessionTag[] | null }>();
  /** Tags de la session : ceux de l'étiqueteur, corrigés à la main (Get-SessionTags). */
  sessionTags(id: string): SessionTag[] | null {
    this.reloadTagsManual();
    return applyManual(this.autoTags(id), this.tagsManual.get(id));
  }
  /** Get-AutoTags */
  autoTags(id: string): SessionTag[] | null {
    if (!id) return null;
    const p = join(this.sf('session-tags'), id + '.json');
    let st; try { st = statSync(p); } catch { this.tagsCache.delete(id); return null; }
    if (!st.isFile()) return null;
    const k = `${st.mtimeMs}/${st.size}`;
    let c = this.tagsCache.get(id);
    if (!c || c.k !== k) { c = { k, tags: cleanTags((readJson(p) as { tags?: unknown } | undefined)?.tags) }; this.tagsCache.set(id, c); }
    return c.tags;
  }

  // ───── Correction à la main (lot 3) : sessions-dashboard-tags-manual.json, écrit par le serveur principal ─────
  tagsManual = new Map<string, ManualTags>();
  reloadTagsManual(force = false): void {
    const p = this.sf('sessions-dashboard-tags-manual.json');
    if (!this.#changed(p, force)) return;
    this.tagsManual = parseManual(readJson(p));
  }
  /** Listes fermées : publiées par l'étiqueteur, sinon la section `tagger` du fichier de configuration. */
  tagVocab(): { domaines: string[]; outils: string[] } { return loadVocab(this.sf('session-tags'), this.cfg.tagVocab); }
  /** Set-SessionTag : null, ou le motif du refus (même texte que le .ps1). */
  setTag(id: string, axis: string, v: string, on: boolean): string | null {
    const err = checkTag(id, axis, v, this.tagVocab()); if (err) return err;
    this.reloadTagsManual();
    let m = this.tagsManual.get(id);
    if (!m) { m = { add: [], remove: [] }; this.tagsManual.set(id, m); }
    const same = (t: { axis: string; v: string }) => t.axis === axis && t.v === v;
    const [from, to] = on ? [m.remove, m.add] : [m.add, m.remove];
    for (let i = from.length - 1; i >= 0; i--) if (same(from[i]!)) from.splice(i, 1);
    // Un retrait ne s'inscrit que contre un tag AUTOMATIQUE (retirer son propre ajout ne doit pas masquer une future
    // proposition de l'étiqueteur) ; un ajout, seulement s'il n'est pas déjà proposé automatiquement.
    const isAuto = (this.autoTags(id) ?? []).some(same);
    if (on !== isAuto && !to.some(same) && to.length < 20) to.push({ axis, v });
    if (!m.add.length && !m.remove.length) this.tagsManual.delete(id);
    const out: Record<string, ManualTags> = {};
    for (const k of [...this.tagsManual.keys()].sort()) out[k] = this.tagsManual.get(k)!;
    try { const p = this.sf('sessions-dashboard-tags-manual.json'); setContent(p, JSON.stringify(out)); this.#changed(p, true); } catch { /* comme le .ps1 */ }
    return null;
  }

  // ───── Get-SessionMeta ─────
  findTranscript(id: string): string | null {
    for (const d of listDir(this.projectsDir)) {
      const p = join(this.projectsDir, d, id + '.jsonl');
      if (isFile(p)) return p;
    }
    return null;
  }
  meta(id: string, knownPath?: string | null): Meta {
    let c = this.metaCache.get(id);
    if (!c) { c = { path: null, len: -1, title: null, pr: null, prUrl: null, cwd: null, reply: null, tokens: null, model: null, wt: null, recette: false, quiet: null, createdAt: null, queued: [] }; this.metaCache.set(id, c); }
    if (!c.path && knownPath) c.path = knownPath;
    if (!c.path) { c.path = this.findTranscript(id); if (!c.path) return c; }
    if (c.createdAt == null) c.createdAt = transcriptCreatedAt(c.path);
    let size: number;
    try { size = statSync(c.path).size; } catch { return c; }
    if (size === c.len) return c;
    c.len = size;
    const replyLines: string[] = []; let usageLine: string | null = null; const wtLines: string[] = [];
    const tail = readTail(c.path, 512 * 1024);
    try { c.quiet = lastNewsAt(tail); } catch { c.quiet = null; }
    c.queued = pendingQueue(tail);
    for (const l of tail) {
      if (l.startsWith('{"parentUuid"') && l.includes('"type":"assistant"') && !l.includes('"isSidechain":true')) {
        if (l.includes('"usage"')) usageLine = l;
        const mm = l.match(MODEL_RX); if (mm) c.model = mm[1]!;
        if (l.includes('worktrees')) wtLines.push(l);
        if (!c.recette && l.includes('"type":"tool_use"') && RECETTE_RX.test(l)) c.recette = true;
        if (l.includes('"type":"text"')) replyLines.push(l);
        continue;
      }
      if (l.startsWith('{"type":"ai-title"') || l.startsWith('{"type":"custom-title"')) {
        try { const j = JSON.parse(l) as Record<string, unknown>; const t = j.customTitle ?? j.aiTitle; if (t) c.title = psString(t); } catch { /* ligne cassée */ }
      } else if (l.startsWith('{"type":"pr-link"')) {
        try { const j = JSON.parse(l) as Record<string, unknown>; c.pr = (j.prNumber as number) ?? null; c.prUrl = (j.prUrl as string) ?? null; } catch { /* idem */ }
      } else if (!c.cwd) {
        const m = imatch(l, CWD_RX);
        if (m) {
          // Le dossier d'où reprendre est celui du LANCEMENT : celui dont le nom « aplati » est le dossier du transcript.
          const slug = leaf(parent(c.path));
          let cand = m[1]!.replace(/\\\\/g, '\\');
          while (cand && !ieq(cand.replace(/[^A-Za-z0-9]/g, '-'), slug)) cand = splitPathParent(cand);
          if (cand) c.cwd = cand;
        }
      }
    }
    // Worktree de travail : parmi les 10 derniers messages qui citent un worktree encore présent, le plus RÉCENT cité
    // dans au moins 2 messages ; à défaut, le plus récent cité.
    const cnt = new Map<string, number>(); const order: string[] = []; let n = 0;
    for (let i = wtLines.length - 1; i >= 0 && n < 10; i--) {
      const inLine = new Set<string>();
      for (const m of wtLines[i]!.matchAll(WT_RX)) {
        const drive = m[1] ?? m[2] ?? '';
        const p = drive.toUpperCase() + ':' + (m[3] ?? '').replace(/\\\\|\//g, '\\') + '\\.claude\\worktrees\\' + m[4];
        if (!this.wtExists.has(p)) { if (isDir(p) || isFile(p)) this.wtExists.add(p); else continue; }
        inLine.add(p);
      }
      if (!inLine.size) continue;
      n++;
      for (const p of inLine) { cnt.set(p, 1 + (cnt.get(p) ?? 0)); if (!order.includes(p)) order.push(p); }
    }
    if (order.length) c.wt = order.find((p) => (cnt.get(p) ?? 0) >= 2) ?? order[0]!;
    // Taille du contexte = entrée + cache lu + cache écrit du dernier appel au modèle.
    if (usageLine) {
      const u = usageLine.slice(usageLine.indexOf('"usage"')); let t = 0;
      for (const k of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) { const mm = u.match(new RegExp(`"${k}":(\\d+)`, 'i')); if (mm) t += Number(mm[1]); }
      if (t) c.tokens = t;
    }
    for (let i = replyLines.length - 1; i >= 0 && i >= replyLines.length - 4; i--) {
      try {
        const j = JSON.parse(replyLines[i]!) as { type?: string; isSidechain?: unknown; message?: { content?: unknown } };
        if (!ieq(j.type, 'assistant') || j.isSidechain) continue;
        const content = j.message?.content;
        const texts = Array.isArray(content) ? content.filter((b) => b && typeof b === 'object' && ieq(psString((b as { type?: unknown }).type), 'text')) : [];
        const last = texts.length ? (texts[texts.length - 1] as { text?: unknown }).text : null;
        const t = netTrim(psString(last));
        if (t) { c.reply = t.length > 900 ? '… ' + t.slice(t.length - 900) : t; break; }
      } catch { /* ligne cassée */ }
    }
    return c;
  }

  // ───── Update-Prompts / Get-Prompts ─────
  updatePrompts(): void {
    const hist = this.f('history.jsonl');
    let size: number;
    try { size = statSync(hist).size; } catch { return; }
    if (size === this.histLen) return;
    this.histLen = size;
    const p = new Map<string, Prompt[]>();
    for (const l of readTail(hist, 3 * 1024 * 1024)) {
      let h: Record<string, unknown>;
      try { h = JSON.parse(l); } catch { continue; }
      if (!h || !h.sessionId) continue;
      const sid = psString(h.sessionId);
      let list = p.get(sid); if (!list) { list = []; p.set(sid, list); }
      const d = psString(h.display);
      list.push({ at: h.timestamp ?? null, text: d.slice(0, Math.min(400, d.length)) });
    }
    this.prompts = p;
  }
  getPrompts(id: string, count: number): Prompt[] { const l = this.prompts.get(id); return l ? l.slice(-count) : []; }
  /** Sujet ACTUEL d'une session : le dernier ticket (module « tickets », ex. HD-xxxxxx) cité dans SES prompts tapés (tous, pas seulement les 6 affichés),
   *  sauf s'il est déjà dans le premier message (pas de changement de sujet). Le titre (ai-title) est figé au premier
   *  sujet : la page le complète par « → HD-… ». */
  topicHd(id: string): string | null {
    const pat = this.cfg.modules.tickets?.pattern; if (!pat) return null;
    const l = this.prompts.get(id); if (!l) return null;
    for (let i = l.length - 1; i >= 0; i--) {
      const ms = [...psString(l[i]!.text).matchAll(new RegExp('\\b(?:' + pat + ')\\b', 'gi'))];
      if (!ms.length) continue;
      const hd = ms[ms.length - 1]![0]!.toUpperCase();
      return new RegExp('\\b' + hd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(psString(l[0]!.text)) ? null : hd;
    }
    return null;
  }

  // ───── PR, git ─────
  get prFile(): string { return this.sf('sessions-dashboard-pr.json'); }
  get gitFile(): string { return this.sf(`sessions-dashboard-git${this.cfg.suffix}.json`); }
  readPrState(): void {
    if (!this.#changed(this.prFile)) return;
    const j = readJson(this.prFile);
    if (j && typeof j === 'object') this.prState = j as Record<string, PrInfo>;
  }
  prInfo(url: string | null): PrInfo | null { return url ? this.prState[url] ?? null : null; }
  /** Read-GitState */
  readGitState(): void {
    if (!this.#changed(this.gitFile)) return;
    const j = readJson(this.gitFile);
    if (j && typeof j === 'object') this.gitState = j as Record<string, GitInfo>;
  }
  /** Get-GitDir */
  static gitDir(m: Meta, s: Record<string, unknown>): string { return m.wt || m.cwd || psString(s.cwd); }

  // ───── statut busy périmé, proposition ─────
  /** Test-ScreenIdle */
  static screenIdle(text: string | null): boolean {
    if (!text) return false;
    const l = text.split('\n').filter((x) => netTrim(x) && !/^\s*─+\s*$/.test(x));
    const foot = l.slice(-6).join('\n');
    const tail = l.slice(-20).join('\n');
    return !(/esc to interrupt/i.test(foot) || /^\s*\S\s+\S+…\s*\(\d/im.test(tail));
  }
  /** Ligne d'activité de Claude Code (« ✻ Pondering… (12s · ↓ 1.2k tokens · esc to interrupt) ») : le verbe et les
   *  tokens du tour, pour que la page anime « au travail » comme le terminal. Null si l'écran n'en montre pas. */
  static screenSpin(text: string | null): Spin | null {
    if (!text) return null;
    const l = text.split('\n').filter((x) => netTrim(x)).slice(-20);
    for (let i = l.length - 1; i >= 0; i--) {
      const m = /^\s*[·✢✳✶✻✽✺*]\s+([^\s(…][^(…]{0,60}?)…\s*(?:\((.*?)\)?)?\s*$/.exec(l[i]!);
      if (!m) continue;
      const tk = /([↑↓])\s*([\d.,]+\s*[kKmM]?)\s*tokens?/.exec(m[2] ?? '');
      return { verb: netTrim(m[1]!), tokens: tk ? tk[1]! + ' ' + tk[2]!.replace(/\s+/g, '') : null };
    }
    return null;
  }
  /** Verbe du tour lu sur l'écran, tant que la session est au travail (lecture faite par busyFix, aucun appel de plus). */
  spinOf(s: Record<string, unknown>): Spin | null {
    const c = this.screenChk.get(String(s.pid));
    return c && c.mark === (Number(s.statusUpdatedAt) || 0) ? c.spin ?? null : null;
  }
  /** Get-BusyFix */
  async busyFix(s: Record<string, unknown>, now: number): Promise<{ since: number; via: string } | null> {
    const key = String(s.pid); const mark = Number(s.statusUpdatedAt) || 0;
    if (!ieq(psString(s.status), 'busy')) { this.screenChk.delete(key); return null; }
    const stop = this.stops.get(psString(s.sessionId)) ?? 0;
    const hooked = stop > mark && now - stop >= 1500;
    if (!hooked && now - mark < 30000) { this.screenChk.delete(key); return null; }
    let c = this.screenChk.get(key);
    if (!c || c.mark !== mark) { c = { mark, at: 0, idleSince: 0, logged: false, hookRead: false }; this.screenChk.set(key, c); }
    if (now - c.at >= 3000 || (hooked && !c.hookRead)) {
      c.at = now; if (hooked) c.hookRead = true;
      let t: string | null = null;
      try { t = await this.driver.call('read', { pid: Number(s.pid) }); } catch { /* console illisible */ }
      const idle = !t ? hooked : Dashboard.screenIdle(t);
      c.spin = idle ? null : Dashboard.screenSpin(t);
      if (!idle) c.idleSince = 0; else if (!c.idleSince) c.idleSince = now;
    }
    if (!c.idleSince || (!hooked && now - c.idleSince < 3000)) return null;
    const via = hooked ? 'hook' : 'screen';
    if (!c.logged) {
      c.logged = true;
      // Journal partagé : seul le serveur principal l'écrit (à côté du .ps1, chaque ligne serait en double).
      if (this.cfg.primary || this.cfg.allowWrite) {
        try { addContent(this.sf('sessions-dashboard-stale.jsonl'), JSON.stringify({ at: now, via, pid: s.pid, sessionId: s.sessionId, busySince: mark, stopAt: stop, version: s.version ?? null })); } catch { /* idem */ }
      }
    }
    return { since: hooked ? stop : c.idleSince, via };
  }
  /** Get-CachedSuggestion */
  async cachedSuggestion(s: Record<string, unknown>, status: string, now: number, budget: { n: number }): Promise<string | null> {
    const key = String(s.pid);
    if (!ieq(status, 'idle') && !ieq(status, 'shell')) { this.sugCache.delete(key); return null; }
    let c = this.sugCache.get(key); const mark = Number(s.statusUpdatedAt) || 0;
    const isNew = !c || c.mark !== mark;
    if (isNew || (now - c!.at >= 10000 && budget.n > 0)) {
      if (!isNew) budget.n--;
      let t: string | null = null;
      try { t = await this.driver.call('suggestion', { pid: Number(s.pid) }); } catch { /* idem */ }
      c = { mark, at: now, text: t }; this.sugCache.set(key, c);
    }
    return c && c.mark === mark ? c.text : null;
  }

  // ───── Get-OpenSessions ─────
  async alivePids(): Promise<Set<number>> {
    try { return new Set((await this.driver.call('procs', { name: 'claude' }) as { pid: number }[]).map((p) => p.pid)); } catch { return new Set(); }
  }
  async openSessions(): Promise<Session[]> {
    const now = nowMs(); const budget = { n: 3 };
    const alive = await this.alivePids();
    const out: Session[] = [];
    for (const name of listDir(this.sessionsDir)) {
      if (!name.toLowerCase().endsWith('.json')) continue;
      const s = readJson(join(this.sessionsDir, name)) as Record<string, unknown> | undefined;
      if (!s || typeof s !== 'object') continue;
      if (!alive.has(Math.trunc(Number(s.pid) || 0))) continue;
      if (this.cfg.modules.quota?.probe && isProbeCwd(this.cfg, s.cwd)) continue;   // sonde d'usage : jamais dans la liste
      const sid = psString(s.sessionId);
      const m = this.meta(sid);
      const pr = this.getPrompts(sid, 6);
      let status = (s.status ?? null) as string; let since = Number(s.statusUpdatedAt) || 0; let stale: string | null = null;
      // AUTOMATE (claude -p) : déclaré « interactive » mais sans terminal (entrypoint sdk-cli au lieu de cli).
      const headless = Boolean(s.entrypoint) && !ieq(psString(s.entrypoint), 'cli');
      const fix = headless ? null : await this.busyFix(s, now);
      if (fix) { status = 'idle'; since = fix.since; stale = fix.via; }
      const sug = headless ? null : await this.cachedSuggestion(s, status ?? '', now, budget);
      const gd = Dashboard.gitDir(m, s);
      out.push({
        pid: s.pid as number, name: s.name ?? null, title: m.title, pr: m.pr, prUrl: m.prUrl, prInfo: this.prInfo(m.prUrl), reply: m.reply, tokens: m.tokens, model: m.model,
        wt: m.wt, recette: m.recette, tags: this.sessionTags(sid), gitDir: gd, git: this.gitState[gd.toLowerCase()] ?? null,
        status, stale, spin: ieq(status, 'busy') ? this.spinOf(s) : null, bg: null, headless, entrypoint: s.entrypoint ?? null, hookStop: this.stops.get(sid) ?? 0, waitingFor: s.waitingFor ?? null,
        // « À relire » : fin de tour après le dernier « vu » — sauf tour sans nouveauté (réveil programmé à réponse
        // identique, relance du veilleur), où c'est la fin du dernier tour qui comptait qui fait foi.
        done: ieq(status, 'idle') && (m.quiet ? m.quiet.at : since) > (this.seen.get(sid) ?? 0),
        ...(m.quiet ? { quiet: m.quiet.why } : {}),   // absent hors de ce cas : l'état reste celui du .ps1
        statusSince: since, startedAt: s.startedAt ?? null, createdAt: m.createdAt, cwd: s.cwd ?? null,
        sessionId: s.sessionId as string, version: s.version ?? null,
        lastPrompt: pr.length ? pr[pr.length - 1]!.text : '', prompts: pr, suggestion: sug, topicHd: this.topicHd(sid),
        // En file : seulement tant qu'elle travaille (au repos, Claude Code a déjà pris la file).
        queued: ieq(status, 'busy') ? m.queued : [],
        // Verdict du juge (« attend l'utilisateur ? ») sur une session au repos : absent tant qu'il n'est pas rendu.
        ...(this.askJudge && !headless && (ieq(status, 'idle') || ieq(status, 'shell')) ? { askVerdict: this.askJudge.verdict(sid, m.reply) } : {}),
      } as Session);
    }
    return out;
  }

  // ───── redémarrage de Windows ─────
  get openFile(): string { return this.sf(`sessions-dashboard-open${this.cfg.suffix}.json`); }
  get rebootFile(): string { return this.sf(`sessions-dashboard-reboot${this.cfg.suffix}.json`); }
  initReboot(): void {
    try {
      const o = readJson(this.openFile) as { boot?: number; seen?: Record<string, number> } | undefined;
      if (o) {
        const prev = new Map<string, number>(Object.entries(o.seen ?? {}).map(([k, v]) => [k, Number(v) || 0]));
        if (Math.abs((Number(o.boot) || 0) - this.bootMs) > 120000) {
          if (prev.size) {
            const max = Math.max(...prev.values());
            setContent(this.rebootFile, JSON.stringify({ at: max, ids: [...prev.keys()].filter((k) => prev.get(k)! >= max - 180000) }));
          }
        } else this.openSeen = prev;
      }
    } catch { /* comme le .ps1 */ }
    const r = readJson(this.rebootFile) as { at: number; ids: unknown } | undefined;
    this.reboot = r ? { at: Number(r.at) || 0, ids: (Array.isArray(r.ids) ? r.ids : r.ids ? [r.ids] : []).map(psString) } : null;
  }
  /** Save-OpenSeen */
  saveOpenSeen(sessions: Session[]): void {
    const now = nowMs();
    for (const s of sessions) if (s.title && s.sessionId && !s.headless) this.openSeen.set(s.sessionId, now);
    if (now - this.openSaved < 30000) return;
    this.openSaved = now;
    for (const [k, v] of this.openSeen) if (v < now - 7 * 86400000) this.openSeen.delete(k);
    try { setContentAtomic(this.openFile, JSON.stringify({ boot: this.bootMs, seen: Object.fromEntries(this.openSeen) })); } catch { /* idem */ }
  }
  /** Get-RebootInfo */
  rebootInfo(sessions: Session[]): unknown {
    if (!this.reboot) return null;
    if (nowMs() - this.rebootView.at < 5000) return this.rebootView.value;
    this.rebootView.at = nowMs();
    const open = new Set(sessions.map((s) => s.sessionId));
    const list: Record<string, unknown>[] = [];
    for (const id of this.reboot.ids) {
      if (open.has(id)) continue;
      const m = this.meta(id);
      if (!m.path || !m.title) continue;
      list.push({ sessionId: id, title: m.title, cwd: m.cwd, pr: m.pr, lastActivity: Math.trunc(mtimeMs(m.path)) });
    }
    list.sort((a, b) => (b.lastActivity as number) - (a.lastActivity as number));
    this.rebootView.value = list.length ? { at: this.reboot.at, sessions: list } : null;
    return this.rebootView.value;
  }
  /** Clear-Reboot */
  clearReboot(): void { this.reboot = null; this.rebootView.value = null; try { rmSync(this.rebootFile, { force: true }); } catch { /* idem */ } }

  /** Write-StatusChanges */
  writeStatusChanges(sessions: Session[]): void {
    const now = nowMs();
    for (const s of sessions) {
      const k = `${psString(s.status)}|${psString(s.stale)}`;
      if (this.lastStatus.get(s.sessionId) === k) continue;
      const from = this.lastStatus.get(s.sessionId) ?? null; this.lastStatus.set(s.sessionId, k);
      let r = netTrim(psString(s.reply).replace(/\s+/g, ' ')); if (r.length > 160) r = '…' + r.slice(r.length - 160);
      try { addContent(this.sf(`sessions-dashboard-status${this.cfg.suffix}.jsonl`), JSON.stringify({ at: now, pid: s.pid, sessionId: s.sessionId, title: s.title, from, status: s.status, stale: s.stale, reply: r })); } catch { /* idem */ }
    }
  }

  /** Get-State */
  async state(): Promise<Record<string, unknown>> {
    this.updatePrompts();
    this.readGitState();
    this.reloadSeen(); this.reloadFavs(); this.reloadHidden();
    if (!this.cfg.primary) this.notifs = this.readNotifsFile();
    const restarts: unknown[] = [];
    for (const l of readTail(this.sf('restart-idle-sessions.jsonl'), 64 * 1024)) { try { restarts.push(JSON.parse(l)); } catch { /* idem */ } }
    const sess = await this.openSessions();
    try { this.saveOpenSeen(sess); } catch { /* idem */ }
    try { this.writeStatusChanges(sess); } catch { /* idem */ }
    let quota: unknown[] = [];
    try { quota = markActiveAccount(readClaudeUsage(this.cfg), activeAccountUuid(this.cfg)); } catch { /* idem */ }
    return { now: nowMs(), sessions: sess, reboot: this.rebootInfo(sess), restarts: restarts.slice(-40), favs: [...this.favs], hidden: [...this.hidden], drafts: this.drafts.list(), notifs: this.notifs.slice(-60), quota, promptSuggestion: promptSuggestionSetting(this.cfg), teams: this.cfg.modules.teams ? this.teamsWaits() : null, modules: modulesView(this.cfg.modules), ui: this.cfg.ui, configError: this.cfg.configError, configWarnings: this.cfg.configWarnings };
  }

  /** Get-TeamsWaits : résumé tenu par teams-watcher.ts (state/teams-waits/_summary.json), relu quand il change. */
  teamsCache: { k: string; value: unknown } = { k: '', value: null };
  teamsWaits(): unknown {
    const p = join(this.sf('teams-waits'), '_summary.json');
    let st; try { st = statSync(p); } catch { this.teamsCache = { k: '', value: null }; return null; }
    const k = `${st.mtimeMs}/${st.size}`;
    if (this.teamsCache.k !== k) {
      const v = readJson(p) as { sessions?: unknown } | undefined;
      this.teamsCache = { k, value: v && v.sessions && typeof v.sessions === 'object' && !Array.isArray(v.sessions) ? v : null };
    }
    return this.teamsCache.value;
  }

  // ───── Get-Closed ─────
  rescanClosed(): void {
    if (nowMs() - this.closedScan.at < 30000) return;
    this.closedScan.at = nowMs();
    const since = nowMs() - this.cfg.closedDays * 86400000;
    const files: { id: string; path: string; mtime: number }[] = [];
    for (const d of listDir(this.projectsDir)) {
      const dir = join(this.projectsDir, d);
      if (!isDir(dir)) continue;
      for (const f of listDir(dir)) {
        if (!f.toLowerCase().endsWith('.jsonl')) continue;
        const p = join(dir, f);
        let st; try { st = statSync(p); } catch { continue; }
        if (!st.isFile() || st.mtimeMs < since) continue;
        files.push({ id: f.slice(0, -6), path: p, mtime: st.mtimeMs });
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    this.closedScan.files = files.slice(0, 600);
  }
  async closed(): Promise<Record<string, unknown>> {
    this.updatePrompts();
    this.rescanClosed();
    const openIds = new Set((await this.openSessions()).map((s) => s.sessionId));
    const list: Record<string, unknown>[] = [];
    for (const f of this.closedScan.files) {
      if (openIds.has(f.id)) continue;
      const m = this.meta(f.id, f.path);
      if (!m.title) continue;
      const pr = this.getPrompts(f.id, 6);
      list.push({ sessionId: f.id, title: m.title, pr: m.pr, prUrl: m.prUrl, prInfo: this.prInfo(m.prUrl), reply: m.reply, tokens: m.tokens, model: m.model, cwd: m.cwd, wt: m.wt, recette: m.recette, tags: this.sessionTags(f.id),
        lastActivity: Math.trunc(f.mtime), createdAt: m.createdAt, lastPrompt: pr.length ? pr[pr.length - 1]!.text : '', prompts: pr, topicHd: this.topicHd(f.id) });
    }
    return { days: this.cfg.closedDays, closed: list.slice(0, 400) };
  }

  /** Get-NewFolders : dossiers récents (sessions ouvertes, puis fermées), plus les dossiers déclarés du poste. */
  async newFolders(): Promise<NewFolder[]> {
    await this.closed();
    const by = new Map<string, { path: string; last: number; count: number }>();
    const add = (p: unknown, at: number): void => {
      if (!p) return;
      const s = psString(p);
      const k = s.replace(/\\+$/, '').toLowerCase();
      let e = by.get(k); if (!e) { e = { path: s.replace(/\\+$/, ''), last: 0, count: 0 }; by.set(k, e); }
      e.count++; if (at > e.last) e.last = at;
    };
    const appData = (this.cfg.home + '\\AppData\\').toLowerCase();
    for (const f of this.closedScan.files) {
      const m = this.meta(f.id, f.path);
      if (!m.title || (m.cwd && m.cwd.toLowerCase().startsWith(appData))) continue;
      add(m.cwd, Math.trunc(f.mtime));
    }
    for (const s of await this.openSessions()) add(s.cwd, nowMs());
    return withDeclaredFolders([...by.values()], this.cfg.newFolders ?? [], isDir);
  }
}
