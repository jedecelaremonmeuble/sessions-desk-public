// Vue LANCEUR (module « launcher » : un orchestrateur externe, son dossier de données) — Get-Launcher, Get-LauncherAlerts,
// Invoke-LauncherAlerts, Get-LaunchFile, Add-RunInfo, Get-LaunchTitle du .ps1. Lecture seule.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { CardsFeed } from './cards.ts';
import type { Dashboard } from './state.ts';
import { launchMs, readClaudeUsage, readUsageRaw, roundHalfEven } from './usage.ts';
import { exists, isDir, leaf, netTrim, nowMs, psString, readJson, setContent, splitPathParent } from './util.ts';
import { ntfsSort } from './state.ts';
import { T } from './i18n.ts';
import { runLive } from './run-live.ts';

type Obj = Record<string, unknown>;
const FILE_EXT = ['.md', '.html', '.json', '.png', '.patch', '.diff', '.txt', '.sql', '.log'];
/** Réglages et configuration MCP d'un run : ni listés, ni servis (ils peuvent porter des jetons). */
const HIDDEN_FILES = ['settings.json', 'mcp.json'];
// Sort-Object Name : comparaison de la culture courante, sans tenir compte de la casse.
const collator = new Intl.Collator(undefined, { sensitivity: 'accent' });

/** Add-RunInfo : tout objet du state qui porte un runDir décrit un run. */
function addRunInfo(index: Map<string, Obj>, o: unknown): void {
  if (o === null || o === undefined || typeof o !== 'object') return;
  if (Array.isArray(o)) { for (const x of o) addRunInfo(index, x); return; }
  const r = o as Obj;
  if ('runDir' in r && r.runDir) {
    index.set(psString(r.runDir).toLowerCase(), {
      outcome: r.outcome ?? r.sessionOutcome ?? r.status ?? null, verdict: r.verdict ?? null, detail: psString(r.detail),
      minutes: r.minutes ?? r.sessionMinutes ?? null, costUsd: r.costUsd ?? null, turns: r.turns ?? null, sessionId: r.sessionId ?? null,
    });
  }
  for (const [k, v] of Object.entries(r)) if (k !== 'mcpServers' && typeof v !== 'string') addRunInfo(index, v);
}

function listDirs(dir: string): { name: string; full: string; mtime: number }[] {
  let names: string[]; try { names = ntfsSort(readdirSync(dir)); } catch { return []; }
  const out = [];
  for (const n of names) { const full = join(dir, n); try { const st = statSync(full); if (st.isDirectory()) out.push({ name: n, full, mtime: st.mtimeMs }); } catch { /* disparu */ } }
  return out;
}
function walkFiles(dir: string, name: string, acc: { full: string; mtime: number }[] = []): { full: string; mtime: number }[] {
  let names: string[]; try { names = readdirSync(dir); } catch { return acc; }
  for (const n of names) {
    const full = join(dir, n);
    let st; try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walkFiles(full, name, acc);
    else if (n.toLowerCase() === name) acc.push({ full, mtime: st.mtimeMs });
  }
  return acc;
}
function firstLine(path: string): string | null {
  try { for (const l of readFileSync(path, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) if (netTrim(l)) return l; } catch { /* illisible */ }
  return null;
}

export interface LaunchAlert { key: string; title: string; text: string; hd?: string }
/** Ce qu'attend l'utilisateur, par étape (titre des notifications « t'attend ») — $launchWaitFr du .ps1. */
const WAIT_FR: Record<string, string> = { 'pr-awaiting-approval': 'PR à valider', 'diagnosis-held': 'diagnostic posé, go attendu', 'diagnosis-failed': 'diagnostic en échec',
  'dev-abandoned': 'dev abandonné', 'pr-closed': 'PR fermée sans merge', 'deploy-failed': 'déploiement en échec', 'deploy-unknown': 'pas vu en production',
  'rollback-requested': 'rollback demandé' };

/** Ordres au lanceur depuis le détail d'un run — Get-LauncherOrderArgs du .ps1, à l'identique. La page ne
 *  fait que TAPER la commande du lanceur ; la commande refait ses gardes, dépose l'ordre et le relève. Texte libre
 *  derrière « -- » (jamais lu comme une option) ; merge seulement avec confirm === true ; abandon seulement avec son
 *  mot pour le demandeur. null = demande invalide. */
export function orderArgs(j: unknown): string[] | null {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const o = j as Obj;
  const hd = psString(o.hd), order = psString(o.order), text = psString(o.text).replace(/\s+/g, ' ').trim();
  if (!/^[1-9]\d{0,8}$/.test(hd) || text.length > 2000) return null;
  let a: string[] | null = null;
  switch (order) {
    case 'go': a = ['go', hd]; break;
    case 'merge': {
      // « J'ai relu, livrer » (livraison refusée, commits ajoutés) : le sha relu, et lui seul, est adopté.
      const adopt = o.adoptHead === undefined || o.adoptHead === null ? '' : psString(o.adoptHead);
      if (o.confirm !== true || (adopt && !/^[0-9a-f]{40}$/.test(adopt))) break;
      a = adopt ? ['merge', hd, '--adopt-head', adopt] : ['merge', hd];
      break;
    }
    // Sujet sans intérêt : jamais sans le mot qui prévient le demandeur (c'est aussi le motif de l'abandon).
    case 'abandon': a = text ? ['abandon', hd, '--', text] : null; break;
    case 'review': a = ['review', hd]; break;
    case 'rework': a = ['rework', hd]; break;
    case 'recette-skip': a = ['recette', 'skip', hd]; break;
    case 'verdict': { const v = psString(o.value); a = ['ok', 'partiel', 'faux'].includes(v) ? ['verdict', hd, v] : null; break; }
    case 'decide': {
      const v = psString(o.value);
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(v)) break;
      a = ['decide', hd, v];
      const c = o.choices;
      if (c && typeof c === 'object' && !Array.isArray(c)) {
        for (const [q, opt] of Object.entries(c as Obj)) {
          const ov = psString(opt);
          if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(q) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(ov)) { a = null; break; }
          a.push('--choice', `${q}=${ov}`);
        }
      }
      break;
    }
  }
  if (a && text && (order === 'go' || order === 'verdict' || order === 'decide')) a.push('--', text);
  return a;
}

/** Invoke-LauncherOrder : { ok, message } ou { error } (1re ligne de la commande, qui dit le refus). */
export function runLauncherOrder(j: unknown, env: NodeJS.ProcessEnv = process.env, mod: { cli: string; python: string } | null = null): Promise<Obj> {
  const args = orderArgs(j);
  if (!args) return Promise.resolve({ error: T('demande invalide', 'invalid request') });
  const cli = env.SD_LAUNCHER_CLI || mod?.cli || '';
  if (!cli) return Promise.resolve({ error: T('commande du lanceur non configurée (modules.launcher.cli)', 'launcher command not configured (modules.launcher.cli)') });
  if (!existsSync(cli)) return Promise.resolve({ error: T(`commande du lanceur introuvable (${cli})`, `launcher command not found (${cli})`) });
  return new Promise((done) => {
    let settled = false;
    // La commande répond en une seconde ; au-delà de 30 s on répond SANS tuer : l'ordre est peut-être déjà déposé.
    const t = setTimeout(() => { if (!settled) { settled = true; done({ error: T('le lanceur ne répond pas en 30 s — voir sa vue 🤖 avant de recommencer', 'the launcher did not answer within 30 s — check its 🤖 view before trying again') }); } }, 30000);
    execFile(env.SD_LAUNCHER_PYTHON || mod?.python || 'python', ['-X', 'utf8', cli, ...args], { cwd: dirname(cli), windowsHide: true, encoding: 'utf8', env: { ...env, PYTHONIOENCODING: 'utf-8' } },
      (err, stdout, stderr) => {
        clearTimeout(t); if (settled) return; settled = true;
        const lines = String(stdout ?? '').split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
        if (!err) { done({ ok: true, message: lines.join('\n') }); return; }
        if (lines[0]) { done({ error: lines[0].trim() }); return; }
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') { done({ error: T('lanceur injoignable : python introuvable', 'launcher unreachable: python not found') }); return; }
        const e = String(stderr ?? '').trim().split('\n');
        done({ error: e[e.length - 1]?.trim() || T('lanceur en échec', 'launcher failed') });
      });
  });
}

/** Livraison refusée parce que la PR a reçu des commits après les contrôles : ce qui est arrivé depuis, lu par la
 *  commande du lanceur `delivery-diff <hd>` (LECTURE SEULE, JSON sur la dernière ligne). Pas de cache : le sha montré doit être celui de la PR au moment de relire (D2). Get-LauncherDeliveryDiff. */
export function lookupDeliveryDiff(hd: string, env: NodeJS.ProcessEnv = process.env, mod: { cli: string; python: string } | null = null): Promise<Obj> {
  if (!/^[1-9]\d{0,8}$/.test(hd)) return Promise.resolve({ error: T('demande invalide', 'invalid request') });
  const cli = env.SD_LAUNCHER_CLI || mod?.cli || '';
  if (!cli) return Promise.resolve({ error: T('commande du lanceur non configurée (modules.launcher.cli)', 'launcher command not configured (modules.launcher.cli)') });
  if (!existsSync(cli)) return Promise.resolve({ error: T(`commande du lanceur introuvable (${cli})`, `launcher command not found (${cli})`) });
  return new Promise((done) => {
    execFile(env.SD_LAUNCHER_PYTHON || mod?.python || 'python', ['-X', 'utf8', cli, 'delivery-diff', hd], { cwd: dirname(cli), windowsHide: true, encoding: 'utf8', timeout: 60000, maxBuffer: 16 << 20, env: { ...env, PYTHONIOENCODING: 'utf-8' } },
      (err, stdout) => {
        const last = String(stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';
        let v: unknown = null; try { v = JSON.parse(last); } catch { v = null; }
        if (v && typeof v === 'object' && !Array.isArray(v)) { done(v as Obj); return; }
        done({ error: err ? T('diff illisible : le lanceur a échoué (' + ((err as NodeJS.ErrnoException).code ?? 'erreur') + ')', 'diff unreadable: the launcher failed (' + ((err as NodeJS.ErrnoException).code ?? 'error') + ')') : T('diff illisible', 'diff unreadable') });
      });
  });
}

// ── La DEMANDE derrière un run (en-tête du détail) : demandeur, date, type, statut… lus par la commande de lecture des tickets du
// lanceur (jeton d'exploitation, LECTURE SEULE), configurée dans modules.launcher.ticketApi. Get-LauncherHd du .ps1.
// hdSummary est PURE : elle ne garde de la réponse que ce que l'en-tête affiche (pas les interactions, ni les gardes).
export function hdSummary(j: unknown): Obj | null {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const t = j as Obj, ir = (t.internalRequest && typeof t.internalRequest === 'object' ? t.internalRequest : {}) as Obj;
  const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const id = typeof t.id === 'number' ? t.id : Number(psString(t.id));
  if (!Number.isInteger(id) || id <= 0) return null;
  const who = Array.isArray(t.mentionable) ? (t.mentionable as Obj[]).find((m) => m && m.agentId && m.agentId === t.requesterAgentId) : undefined;
  const desc = (s(t.description) ?? '').replace(/\s+/g, ' ');
  const teams = s(ir.teamsWebUrl);
  return {
    hd: id, title: s(t.title), requester: s(who?.label), createdAt: s(t.createdAt), status: s(t.status), priority: s(t.priority),
    assignee: s(t.assignee), kind: s(ir.kind), domain: s(ir.domain), severity: s(ir.severity),
    clients: Array.isArray(t.linkedClientIds) ? t.linkedClientIds.length : 0,
    teamsUrl: teams && teams.startsWith('https://teams.microsoft.com/') ? teams : null,
    description: desc ? (desc.length > 400 ? desc.slice(0, 399) + '…' : desc) : null,
  };
}
const hdCache = new Map<string, { at: number; value: Obj }>();
/** Get-LauncherHd : { ...hdSummary } ou { error }. Cache 5 min (1 min sur une erreur) : l'en-tête se redessine toutes les 2 s. */
export function lookupHd(hd: string, env: NodeJS.ProcessEnv = process.env, mod: { ticketApi: string; python: string } | null = null): Promise<Obj> {
  if (!/^[1-9]\d{0,8}$/.test(hd)) return Promise.resolve({ error: T('demande invalide', 'invalid request') });
  const c = hdCache.get(hd);
  if (c && nowMs() - c.at < ('error' in c.value ? 60000 : 300000)) return Promise.resolve(c.value);
  const api = env.SD_LAUNCHER_TICKET_API || mod?.ticketApi || '';
  if (!api) return Promise.resolve({ error: T('lecture des demandes non configurée (modules.launcher.ticketApi)', 'ticket reading not configured (modules.launcher.ticketApi)') });
  if (!existsSync(api)) return Promise.resolve({ error: T(`lecture des demandes introuvable (${api})`, `ticket reader not found (${api})`) });
  return new Promise((done) => {
    execFile(env.SD_LAUNCHER_PYTHON || mod?.python || 'python', ['-X', 'utf8', api, 'ticket', hd, '--max-chars', '600'], { cwd: dirname(api), windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 8 << 20, env: { ...env, PYTHONIOENCODING: 'utf-8' } },
      (err, stdout) => {
        let v: Obj | null = null;
        if (!err) { try { v = hdSummary(JSON.parse(String(stdout))); } catch { v = null; } }
        const value = v ?? { error: err ? T('demande illisible (hors périmètre du jeton, introuvable ou réseau)', 'ticket unreadable (outside the token scope, not found, or network)') : T('réponse illisible', 'unreadable answer') };
        hdCache.set(hd, { at: nowMs(), value }); done(value);
      });
  });
}

export class Launcher {
  readonly d: Dashboard;
  readonly root: string;
  readonly runs: string;
  /** Module « launcher » éteint : aucune route, aucune alerte. */
  readonly enabled: boolean;
  /** Cartes de questions adressées à l'opérateur (cards.ts) ; éteint sans `cardsApi`. */
  readonly cards: CardsFeed;
  readonly #runRe: RegExp;
  readonly #busyRe: RegExp;
  #cache: { at: number; hours: number; value: Obj | null } = { at: 0, hours: 0, value: null };
  #titles = new Map<string, string>();
  #alertAt = 0;

  constructor(d: Dashboard) {
    this.d = d;
    const mod = d.cfg.modules.launcher;
    this.enabled = !!mod;
    this.cards = new CardsFeed(mod, process.env, () => this.invalidate());
    this.root = mod?.root ?? join(d.cfg.temp, 'sessions-desk-sans-lanceur');
    this.runs = join(this.root, 'runs');
    // Un run en cours se reconnaît à sa ligne de commande : <dossier du lanceur>\runs\HD-<n>\<horodatage>…
    const base = basename(this.root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    this.#runRe = new RegExp('\\\\' + base + '(\\\\runs\\\\HD-\\d+\\\\\\d{8}-\\d{6}[^\\\\"\\s]*)', 'i');
    this.#busyRe = new RegExp(base + '\\\\runs', 'i');
  }
  /** Après un ordre : la vue suivante relit l'état du lanceur au lieu du cache de 15 s. */
  invalidate(): void { this.#cache = { at: 0, hours: 0, value: null }; }
  get alertFile(): string { return this.d.sf(`sessions-dashboard-launch-alerts${this.d.cfg.suffix}.json`); }

  /** Get-LaunchTitle : titre de la PR (pr.md / pr-body.md), à défaut 1re phrase de result.md. */
  title(ticketDir: string): string | null {
    const c = this.#titles.get(ticketDir); if (c !== undefined) return c;
    let t: string | null = null;
    for (const pat of ['pr.md', 'pr-body.md', 'result.md']) {
      const f = walkFiles(ticketDir, pat).sort((a, b) => b.mtime - a.mtime)[0];
      if (!f) continue;
      const l = firstLine(f.full);
      if (l) { t = netTrim(l.replace(/^[#\s*]+/, '').replace(/\*\*/g, '')); if (t.length > 140) t = t.slice(0, 137) + '…'; break; }
    }
    if (t) this.#titles.set(ticketDir, t);
    return t;
  }

  async #claudeProcs(): Promise<{ pid: number; started: number | null; commandLine: string | null }[]> {
    try { return await this.d.driver.call('procs', { name: 'claude', commandLine: true }) as never; } catch { return []; }
  }
  #heartbeat(): number { try { const t = Date.parse(readFileSync(join(this.root, 'heartbeat.stamp'), 'utf8').trim()); return Number.isFinite(t) ? t : 0; } catch { return 0; } }

  /** Get-Launcher */
  async view(hours: number): Promise<Obj> {
    if (!isDir(this.runs)) return { present: false };
    if (this.#cache.value && this.#cache.hours === hours && nowMs() - this.#cache.at < 15000) return this.#cache.value;
    const now = nowMs();
    const st = readJson(join(this.root, 'state.json')) as Obj | undefined;
    const stagesRoot = readJson(join(this.root, 'stages.json')) as Obj | undefined;
    const stages = (stagesRoot?.sent ?? null) as Obj | null;
    const index = new Map<string, Obj>(); const titles = new Map<string, unknown>();
    if (st && st.requests && typeof st.requests === 'object') for (const [k, v] of Object.entries(st.requests as Obj)) { titles.set(k, (v as Obj | null)?.title ?? null); addRunInfo(index, v); }
    const live = new Map<string, { pid: number; started: number | null }>();
    for (const p of await this.#claudeProcs()) {
      const m = psString(p.commandLine).match(this.#runRe);
      if (m) live.set(join(this.root, m[1]!.replace(/^\\+/, '')).toLowerCase(), { pid: p.pid, started: p.started });
    }
    const openByPid = new Map<number, Obj>(); for (const s of await this.d.openSessions()) openByPid.set(Math.trunc(Number(s.pid)), s);
    const cut = now - hours * 3600000;
    // Une demande dont une carte attend l'opérateur garde son DERNIER run dans la vue, quel que soit son âge : la carte
    // se traite depuis le détail de ce run.
    const feed = this.cards.current();
    const carded = new Set(((Array.isArray(feed.cards) ? feed.cards : []) as Obj[]).map((c) => psString(c.hd)).filter(Boolean));
    const runs: Obj[] = [];
    for (const t of listDirs(this.runs).filter((x) => x.mtime >= cut || carded.has(x.name.replace(/^HD-/i, '')))) {
      const hd = t.name.replace(/^HD-/i, '');
      if (!titles.get(hd)) titles.set(hd, this.title(t.full));
      const dirs = listDirs(t.full);
      const kept = carded.has(hd) ? dirs.map((x) => x.name).filter((n) => /^\d{8}-\d{6}/.test(n)).sort().pop() ?? null : null;
      for (const d of dirs) {
        const m = d.name.match(/^(\d{8}-\d{6})(?:-(.+))?$/);
        if (!m) continue;
        const s = m[1]!;
        const at = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));
        const phase = m[2] ?? 'diagnostic';
        const key = d.full.toLowerCase(); const lv = live.get(key);
        if (at < cut && !lv && d.name !== kept) continue;
        let names: string[] = []; try { names = readdirSync(d.full); } catch { /* disparu */ }
        const files = names.map((n) => { try { const st2 = statSync(join(d.full, n)); return st2.isFile() ? { name: n, size: st2.size } : null; } catch { return null; } })
          .filter((x): x is { name: string; size: number } => !!x && FILE_EXT.includes(extOf(x.name)) && !HIDDEN_FILES.includes(x.name.toLowerCase()) && x.size < 4 * 1024 * 1024)
          .sort((a, b) => rank(a.name) - rank(b.name) || collator.compare(a.name, b.name));
        const info = index.get(key);
        let sid = (info?.sessionId ?? null) as string | null;
        if (!sid) {
          const tr = join(d.full, 'transcript.jsonl');
          if (existsSync(tr)) { try { for (const l of readFileSync(tr, 'utf8').split('\n').slice(0, 3)) { const mm = l.match(/"session_id":"([0-9a-f-]{36})"/i); if (mm) { sid = mm[1]!; break; } } } catch { /* illisible */ } }
        }
        const os = lv ? openByPid.get(lv.pid) : undefined;
        let stage: unknown = null;
        if (stages && stages[hd]) { try { stage = (JSON.parse(String(stages[hd])) as Obj).stage ?? null; } catch { stage = null; } }
        runs.push({ hd, title: titles.get(hd) ?? null, phase, at, dir: d.full.slice(this.runs.length + 1),
          running: !!lv, pid: lv?.pid ?? null, liveSessionId: os?.sessionId ?? null, tokens: os?.tokens ?? null, model: os?.model ?? null, reply: os ? os.reply ?? null : null,
          outcome: info?.outcome ?? null, verdict: info?.verdict ?? null, detail: info?.detail ?? null, minutes: info?.minutes ?? null, costUsd: info?.costUsd ?? null, turns: info?.turns ?? null,
          sessionId: sid, files, stage,
          // Run en cours : ce qu'il fait maintenant, lu dans son transcript (pas d'écran à lire pour un claude -p).
          live: lv ? runLive(join(d.full, 'transcript.jsonl')) : null });
      }
    }
    runs.sort((a, b) => (b.at as number) - (a.at as number));
    const waiting: Obj[] = [];
    if (stages) for (const [name, raw] of Object.entries(stages)) {
      let g: Obj; try { g = JSON.parse(String(raw)) as Obj; } catch { continue; }
      const stg = psString(g.stage);
      if (['pr-awaiting-approval', 'deploying', 'dev-failed'].includes(stg) || (g.waitingOn && !['diagnosis-held', 'in-production', 'diagnosis-skipped', 'dev-abandoned', 'pr-closed'].includes(stg))) {
        waiting.push({ hd: name, title: titles.get(name) ?? this.title(join(this.runs, `HD-${name}`)), stage: g.stage ?? null, waitingOn: g.waitingOn ?? null, detail: g.detail ?? null,
          prNumber: g.prNumber ?? null, prUrl: g.prUrl ?? null, since: launchMs(g.since),
          refusalKind: g.deliverRefusedKind ?? null, prHead: g.prHead ?? null });
      }
    }
    waiting.sort((a, b) => (b.since as number) - (a.since as number));
    // Décisions de la Tech en attente (tech_decision.py du lanceur) — Get-Launcher du .ps1, à l'identique : questions en
    // TEXTE JSON (la profondeur de sérialisation du .ps1 tronquerait leurs options).
    const decisions: Obj[] = [];
    for (const [name, rec] of Object.entries(((st?.requests ?? {}) as Obj))) {
      const d = (rec as Obj | null)?.techDecision as Obj | undefined;
      if (!d || !d.interaction) continue;
      decisions.push({ hd: name, title: titles.get(name) ?? null, kind: psString(d.kind), interaction: Math.trunc(Number(d.interaction)), since: launchMs(d.postedAt),
        questionsJson: JSON.stringify(Array.isArray(d.questions) ? d.questions : [d.questions]) });
    }
    decisions.sort((a, b) => (b.since as number) - (a.since as number));
    // Sujets abandonnés (ordre « abandon ») : la page le dit dans le détail du run et n'y propose plus d'ordre.
    const abandoned: Obj[] = [];
    for (const [name, rec] of Object.entries(((st?.requests ?? {}) as Obj))) {
      const a = (rec as Obj | null)?.abandoned as Obj | undefined;
      if (a && typeof a === 'object') abandoned.push({ hd: name, at: launchMs(a.at), motive: psString(a.motive).slice(0, 2000) });
    }
    const errors: Obj[] = [];
    for (const k of ['lastPassError', 'lastWait', 'lastPageError', 'lastRerunError', 'lastWakeError', 'lastReactionError']) {
      const e = st?.[k] as Obj | undefined;
      if (e && e.message) errors.push({ kind: k, message: psString(e.message), at: roundHalfEven(Number(e.at ?? 0) * 1000) });
    }
    errors.sort((a, b) => (b.at as number) - (a.at as number));
    const v: Obj = { present: true, now, hours, heartbeat: this.#heartbeat(), quota: readClaudeUsage(this.d.cfg), errors, runs, waiting, decisions, abandoned,
      cards: Array.isArray(feed.cards) ? feed.cards : [], cardsToken: psString(feed.token) || 'unknown', cardsError: feed.error ?? null,
      cost: roundHalfEven(runs.reduce((t, r) => t + (Number(r.costUsd ?? 0) || 0), 0), 2),
      triage: st?.triage ?? null, devMode: st?.devMode ?? null, recetteMode: st?.recetteMode ?? null, reworkMode: st?.reworkMode ?? null };
    this.#cache = { at: nowMs(), hours, value: v };
    return v;
  }

  /** Get-LauncherAlerts : alertes que le lanceur déclencherait, sachant celles déjà signalées ($Seen). */
  async alerts(seen: Obj): Promise<LaunchAlert[]> {
    const alerts: LaunchAlert[] = [];
    if (!exists(this.runs)) return alerts;
    const now = nowMs();
    // 1. Arrêté : muet > 10 min sans run en cours, ou > 45 min de toute façon.
    const hb = this.#heartbeat();
    const busy = (await this.#claudeProcs()).some((p) => this.#busyRe.test(psString(p.commandLine)));
    const age = hb ? now - hb : 0;
    const down = !!hb && ((age > 10 * 60000 && !busy) || age > 45 * 60000);
    if (down && !seen.down) alerts.push({ key: 'down', title: 'Lanceur arrêté ?', text: `Aucun signe de vie depuis ${roundHalfEven(age / 60000)} min${busy ? ' (un run tourne pourtant)' : ', aucun run en cours'} — vérifier la tâche planifiée du lanceur.` });
    if (!down && seen.down) alerts.push({ key: '-down', title: 'Lanceur reparti', text: 'Il donne de nouveau signe de vie.' });
    // 2. Runs en échec.
    const st = readJson(join(this.root, 'state.json')) as Obj | undefined;
    if (st) {
      const index = new Map<string, Obj>();
      if (st.requests && typeof st.requests === 'object') for (const v of Object.values(st.requests as Obj)) addRunInfo(index, v);
      for (const [k, i] of index) {
        const o = `${psString(i.outcome)} ${psString(i.verdict)}`;
        if (!/fail|abandon|error|erreur|denied|refus|timeout|crash/i.test(o)) continue;
        if (seen[`run:${k}`]) continue;
        const lf = leaf(k); const hd = k.match(/hd-(\d+)/i)?.[1] ?? '?';
        const phase = lf.match(/^\d{8}-\d{6}-(.+)$/)?.[1] ?? 'diagnostic';
        const det = psString(i.detail);
        alerts.push({ key: `run:${k}`, title: `Lanceur : ${phase} en échec — HD-${hd}`, text: `${psString(i.outcome)}${i.verdict ? ` · ${psString(i.verdict)}` : ''}${netTrim(det) ? ' — ' + det.slice(0, Math.min(180, det.length)) : ''}` });
      }
    }
    // 3. Tickets passés « dev en échec ».
    const stages = ((readJson(join(this.root, 'stages.json')) as Obj | undefined)?.sent ?? null) as Obj | null;
    if (stages) for (const [name, raw] of Object.entries(stages)) {
      let g: Obj; try { g = JSON.parse(String(raw)) as Obj; } catch { continue; }
      if (psString(g.stage) !== 'dev-failed') continue;
      const key = `stage:${name}:${launchMs(g.since)}`; if (seen[key]) continue;
      // ÉCART VOULU : le .ps1 coupe le texte NETTOYÉ à la longueur du texte BRUT, et lève (aucune alerte de la passe)
      // dès qu'un détail de moins de 200 caractères contient des blancs répétés. Ici, coupe du texte nettoyé.
      const det = psString(g.detail).replace(/\s+/g, ' ');
      alerts.push({ key, title: `Lanceur : dev en échec — HD-${name}`, text: det.slice(0, Math.min(200, det.length)) });
    }
    // 3 ter. Une CARTE de questions attend l'opérateur (cards.ts) : une notification par carte, à la place du « t'attend »
    // de la même demande. Pas de fenêtre de 2 h : une carte ouverte est toujours à traiter, et n'est signalée qu'une fois.
    const feed = this.cards.current();
    const carded = new Set<string>();
    for (const c of (Array.isArray(feed.cards) ? feed.cards : []) as Obj[]) {
      const hd = psString(c.hd); if (!hd) continue;
      carded.add(hd);
      const key = `card:${hd}:${psString(c.id)}`; if (seen[key]) continue;
      const qs = Array.isArray(c.questions) ? (c.questions as Obj[]) : [];
      const first = psString(qs[0]?.question).replace(/\s+/g, ' ');
      alerts.push({ key, hd, title: `Lanceur : HD-${hd} — ${qs.length > 1 ? qs.length + ' questions t’attendent' : 'une question t’attend'}`, text: first.slice(0, Math.min(200, first.length)) });
    }
    // 3 bis. Demande qui PASSE à une étape où c'est à l'utilisateur d'agir (waitingOn = actor) — cadrage L5. Seulement un passage
    // récent (< 2 h) ; exclues « dev en échec » (alerte 3) et « diagnostic écarté » (rien à décider).
    if (stages) for (const [name, raw] of Object.entries(stages)) {
      let g: Obj; try { g = JSON.parse(String(raw)) as Obj; } catch { continue; }
      const stg = psString(g.stage);
      if (psString(g.waitingOn) !== 'actor' || stg === 'dev-failed' || stg === 'diagnosis-skipped') continue;
      if (carded.has(name)) continue;   // une carte attend sur cette demande : c'est elle qui notifie (3 ter)
      const since = launchMs(g.since);
      if (!since || now - since > 2 * 3600000) continue;
      const key = `wait:${name}:${stg}:${since}`; if (seen[key]) continue;
      const det = psString(g.detail).replace(/\s+/g, ' ');
      alerts.push({ key, hd: name, title: `Lanceur : HD-${name} t'attend — ${WAIT_FR[stg] ?? stg}`, text: det.slice(0, Math.min(200, det.length)) });
    }
    // 4. Quota hebdomadaire ≥ seuil d'alerte (ui.quota.alert, 90 % par défaut) : une fois par compte et par période.
    try {
      const raw = readUsageRaw(this.d.cfg) as Record<string, Obj> | undefined;
      //    Même règle pour la limite propre à un modèle (limitsJson, « Fable ») : elle peut saturer avant la limite globale.
      for (const q of Object.values(raw ?? {})) {
        const reset = launchMs(q.weeklyResetsAt);
        if (reset && reset < now) continue;
        const when = reset ? ' ; remise à zéro le ' + formatLocal(reset) : '';
        const key = `quota:${psString(q.alias)}:${psDateString(q.weeklyResetsAt)}`;
        if ((Number(q.weeklyPct) || 0) >= this.d.cfg.ui.quota.alert && !seen[key]) {
          alerts.push({ key, title: `Quota Claude à ${psString(q.weeklyPct)} % — ${psString(q.alias)}`, text: `Quota de la semaine presque épuisé${when}.` });
        }
        let limits: unknown[] = [];
        try { if (q.limitsJson) { const p = JSON.parse(String(q.limitsJson)) as unknown; limits = Array.isArray(p) ? p : [p]; } } catch { limits = []; }
        for (const x of limits) {
          const l = (x ?? {}) as { percent?: unknown; scope?: { model?: { display_name?: unknown } } | null };
          const m = psString(l.scope?.model?.display_name); if (!m || (Number(l.percent) || 0) < 90) continue;
          const mkey = `quota:${psString(q.alias)}:${m}:${psDateString(q.weeklyResetsAt)}`; if (seen[mkey]) continue;
          alerts.push({ key: mkey, title: `Quota Claude ${m} à ${psString(l.percent)} % — ${psString(q.alias)}`, text: `Quota de la semaine du modèle ${m} presque épuisé${when}.` });
        }
      }
    } catch { /* comme le .ps1 */ }
    return alerts;
  }

  /** Invoke-LauncherAlerts : au plus une passe par minute ; notifie chaque alerte une fois. */
  async runAlerts(notify: (title: string, text: string, hd?: string) => void): Promise<void> {
    if (nowMs() - this.#alertAt < 60000) return;
    this.#alertAt = nowMs();
    const first = !exists(this.alertFile);
    const seen = (readJson(this.alertFile) ?? {}) as Obj;
    const alerts = await this.alerts(seen);
    // Plus de 3 « t'attend » dans la même passe (rafale du lanceur) : UNE notification qui les liste.
    const waits = alerts.filter((a) => a.key.startsWith('wait:') || a.key.startsWith('card:')); const burst = waits.length > 3;
    for (const a of alerts) {
      if (a.key === '-down') delete seen.down; else seen[a.key] = nowMs();
      if (burst && (a.key.startsWith('wait:') || a.key.startsWith('card:'))) continue;
      if (!first || a.key === 'down') notify(a.title, a.text, a.hd);
    }
    if (burst && !first) notify(`Lanceur : ${waits.length} demandes t'attendent`, waits.map((a) => `HD-${a.hd}`).join(', '));
    if (alerts.length || first) { try { setContent(this.alertFile, JSON.stringify(seen)); } catch { /* idem */ } }
  }

  /** Get-LaunchFile : fichier d'un run, en TEXTE BRUT ou en image ; chemin bloqué sous runs\. */
  file(rel: string): { status: number; type?: string; body?: Buffer } {
    const full = resolve(this.runs, rel);
    if (!full.toLowerCase().startsWith(this.runs.toLowerCase() + '\\')) return { status: 404 };
    let st; try { st = statSync(full); } catch { return { status: 404 }; }
    if (!st.isFile()) return { status: 404 };
    const ext = extOf(full);
    // Mêmes noms écartés que dans la liste : connaître le chemin ne suffit pas à les lire.
    if (!FILE_EXT.includes(ext) || HIDDEN_FILES.includes(leaf(full).toLowerCase())) return { status: 403 };
    const b = readFileSync(full);
    if (ext === '.png') return { status: 200, type: 'image/png', body: b };
    return { status: 200, type: 'text/plain; charset=utf-8', body: b.length > 2 * 1024 * 1024 ? b.subarray(0, 2 * 1024 * 1024) : b };
  }
}

function extOf(name: string): string { const n = leaf(name); const i = n.lastIndexOf('.'); return i > 0 || (i === 0 && n.length > 1) ? n.slice(i).toLowerCase() : ''; }
function rank(n: string): number { return /^result\.md/i.test(n) ? 0 : /^(review|verdict|findings|rework)/i.test(n) ? 1 : /\.png$/i.test(n) ? 3 : 2; }

/**
 * « "$($q.weeklyResetsAt)" » : ConvertFrom-Json en a fait un DateTime, interpolé au format invariant
 * « MM/dd/yyyy HH:mm:ss » (UTC pour une date en Z, heure locale pour un décalage). Les clés déjà signalées par le
 * .ps1 (fichier d'alertes de la production) restent ainsi reconnues après la bascule.
 */
export function psDateString(v: unknown): string {
  if (typeof v !== 'string') return psString(v);
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(v.trim());
  if (!iso) return v;
  const t = Date.parse(v); if (!Number.isFinite(t)) return v;
  const d = new Date(t); const utc = iso[3] === 'Z';
  const p = (n: number): string => String(n).padStart(2, '0');
  if (!iso[3]) return `${v.slice(5, 7)}/${v.slice(8, 10)}/${v.slice(0, 4)} ${v.slice(11, 13)}:${v.slice(14, 16)}:${iso[1] ? v.slice(17, 19) : '00'}`;
  return utc ? `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
    : `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
/** .LocalDateTime.ToString('ddd dd/MM HH:mm') dans la culture courante (« mer. 18/11 10:00 »). */
export function formatLocal(ms: number): string {
  const d = new Date(ms); const p = (n: number): string => String(n).padStart(2, '0');
  const ddd = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d);
  return `${ddd} ${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export { splitPathParent };
