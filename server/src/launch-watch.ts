// LANCEMENTS EN ATTENTE — « lancée mais rien ne tourne ». Une nouvelle session ouvre un onglet ; si `claude` n'y démarre
// pas vraiment (question d'approbation du dossier, worktree en échec, onglet fermé…), rien n'apparaît dans la liste et
// le lancement semble n'avoir rien fait. Chaque lancement réussi est donc noté ici, puis rapproché des sessions qui
// démarrent (~/.claude/sessions/<pid>.json) ; passé LATE_MS sans session correspondante, la page le signale.
//
// Lecture seule de Claude Code : on ne tape jamais rien dans l'onglet, on n'écrit jamais dans sa configuration.
// Persisté (fichier du poste) : un déploiement suit souvent un lancement, le serveur redémarré reprend la surveillance.
import { randomUUID } from 'node:crypto';
import { fileSize, mtimeMs, readJson, setContentAtomic } from './util.ts';
import { trustKey } from './trust.ts';
import { T } from './i18n.ts';

/** Délai au-delà duquel un lancement sans session est signalé. */
export const LATE_MS = 60_000;
/** Lancements oubliés au-delà (signalés ou non). */
export const KEEP_MS = 24 * 3600_000;
/** Horloges : la session note son démarrage après l'ouverture de l'onglet ; marge pour un léger décalage. */
export const SKEW_MS = 2_000;
const PROMPT_MAX = 160;
const MAX_LAUNCHES = 200;

export interface Launch {
  id: string;
  /** Heure du lancement (ms). */
  at: number;
  /** Dossier où `claude` doit démarrer (worktree visé compris). */
  cwd: string;
  /** Branche neuve : worktree créé par l'onglet, jamais approuvé d'avance. */
  worktree: boolean;
  /** Début du premier message (vide : aucun). */
  prompt: string;
  /** Identifiant fixé d'avance (--session-id), sinon absent. */
  sid?: string;
  state: 'pending' | 'started' | 'dismissed';
  /** Session qui a démarré pour ce lancement (rapprochement fait). */
  startedBy?: string;
  /** Notification déjà envoyée (pas deux fois, même après un redémarrage). */
  alerted?: boolean;
}

/** Session vue dans ~/.claude/sessions (vivante ou non : une session d'avant le lancement ne correspond jamais). */
export interface Observed { sessionId: string; cwd: string; startedAt: number }

/** Rapproche les lancements en attente des sessions démarrées. Pure : renvoie une copie, sans toucher l'entrée.
 *  - identifiant fixé : seule une session de CE identifiant correspond ;
 *  - sinon : même dossier (casse et séparateurs ignorés), démarrée après le lancement (à SKEW_MS près) ;
 *  - une session ne sert qu'à UN lancement : deux lancements dans le même dossier à quelques secondes d'écart
 *    attendent chacun la leur, le plus ancien prenant la plus ancienne. */
export function matchLaunches(launches: readonly Launch[], observed: readonly Observed[], extraStarted: (sid: string) => boolean = () => false): Launch[] {
  const out = launches.map((l) => ({ ...l }));
  const claimed = new Set(out.filter((l) => l.startedBy).map((l) => l.startedBy!.toLowerCase()));
  const pool = [...observed].filter((o) => o.sessionId).sort((a, b) => a.startedAt - b.startedAt);
  for (const l of [...out].sort((a, b) => a.at - b.at)) {
    if (l.state !== 'pending') continue;
    if (l.sid) {
      const want = l.sid.toLowerCase();
      if (pool.some((o) => o.sessionId.toLowerCase() === want) || extraStarted(l.sid)) { l.state = 'started'; l.startedBy = l.sid; claimed.add(want); }
      continue;
    }
    const k = trustKey(l.cwd);
    const hit = pool.find((o) => !claimed.has(o.sessionId.toLowerCase()) && o.startedAt >= l.at - SKEW_MS && trustKey(o.cwd) === k);
    if (hit) { l.state = 'started'; l.startedBy = hit.sessionId; claimed.add(hit.sessionId.toLowerCase()); }
  }
  return out;
}

/** En retard : toujours en attente au-delà de LATE_MS. */
export const isLate = (l: Launch, now: number): boolean => l.state === 'pending' && now - l.at > LATE_MS;

/** Cause probable, dite à l'utilisateur. `trusted` : approbation du dossier (trust.ts), null si inconnue. */
export function probableCause(l: Launch, trusted: boolean | null): { trust: boolean; text: string } {
  if (l.worktree || trusted === false) return { trust: true, text: T(
    'probablement bloquée sur la question d’approbation du dossier (« Do you trust the files in this folder? ») : répondez dans l’onglet',
    'probably waiting on the folder trust question ("Do you trust the files in this folder?"): answer in the tab') };
  return { trust: false, text: T(
    'aucune session n’a démarré : regardez l’onglet (erreur au lancement, worktree non créé, onglet fermé ?)',
    'no session started: check the tab (launch error, worktree not created, tab closed?)') };
}

/** Lecture d'une entrée du fichier ; null si abîmée. */
function clean(x: unknown): Launch | null {
  const o = (x ?? {}) as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || typeof o.cwd !== 'string' || !o.cwd || !Number.isFinite(o.at)) return null;
  const state = o.state === 'started' || o.state === 'dismissed' ? o.state : 'pending';
  return {
    id: o.id, at: Number(o.at), cwd: o.cwd, worktree: o.worktree === true, prompt: typeof o.prompt === 'string' ? o.prompt.slice(0, PROMPT_MAX) : '',
    ...(typeof o.sid === 'string' && o.sid ? { sid: o.sid } : {}), state,
    ...(typeof o.startedBy === 'string' && o.startedBy ? { startedBy: o.startedBy } : {}), ...(o.alerted === true ? { alerted: true } : {}),
  };
}

/** Fichier des lancements surveillés. Relu s'il a changé (autre serveur du poste) ; purgé au-delà de KEEP_MS. */
export class LaunchWatch {
  readonly file: string;
  readonly now: () => number;
  readonly newId: () => string;
  #list: Launch[] = [];
  #stamp = '';

  constructor(file: string, now: () => number = Date.now, newId: () => string = randomUUID) {
    this.file = file; this.now = now; this.newId = newId; this.#reload();
  }

  #reload(): void {
    const stamp = mtimeMs(this.file) + ':' + fileSize(this.file);
    if (stamp === this.#stamp) return;
    this.#stamp = stamp;
    const j = readJson(this.file);
    this.#list = (Array.isArray(j) ? j : []).map(clean).filter((l): l is Launch => l !== null);
  }
  #write(): void {
    try { setContentAtomic(this.file, JSON.stringify(this.#list)); } catch { /* disque : la surveillance continue en mémoire */ }
    this.#stamp = mtimeMs(this.file) + ':' + fileSize(this.file);
  }

  list(): Launch[] { this.#reload(); return this.#list.map((l) => ({ ...l })); }

  /** Note un lancement réussi (onglet ouvert). */
  record(l: { cwd: string; worktree: boolean; prompt: string; sid?: string }): Launch {
    this.#reload();
    const p = l.prompt.replace(/\s+/g, ' ').trim();
    const e: Launch = { id: this.newId(), at: this.now(), cwd: l.cwd, worktree: l.worktree, prompt: p.length > PROMPT_MAX ? p.slice(0, PROMPT_MAX - 1) + '…' : p, ...(l.sid ? { sid: l.sid } : {}), state: 'pending' };
    this.#list.push(e);
    while (this.#list.length > MAX_LAUNCHES) this.#list.shift();
    this.#write();
    return { ...e };
  }

  /** Rapprochement + purge ; écrit seulement si quelque chose a changé. */
  update(observed: readonly Observed[], extraStarted?: (sid: string) => boolean): void {
    this.#reload();
    const now = this.now();
    const kept = this.#list.filter((l) => now - l.at <= KEEP_MS);
    const next = matchLaunches(kept, observed, extraStarted);
    if (kept.length !== this.#list.length || JSON.stringify(next) !== JSON.stringify(this.#list)) { this.#list = next; this.#write(); }
  }

  /** Lancements en retard pas encore notifiés ; marqués notifiés (une seule notification par lancement). */
  takeAlerts(): Launch[] {
    this.#reload();
    const now = this.now();
    const due = this.#list.filter((l) => isLate(l, now) && !l.alerted);
    if (!due.length) return [];
    for (const l of due) l.alerted = true;
    this.#write();
    return due.map((l) => ({ ...l }));
  }

  /** Écarte le signal d'un lancement ; faux s'il n'était plus en attente. */
  dismiss(id: string): boolean {
    this.#reload();
    const l = this.#list.find((x) => x.id === id);
    if (!l || l.state !== 'pending') return false;
    l.state = 'dismissed'; this.#write(); return true;
  }

  /** Pour la page : les lancements en retard, du plus récent au plus ancien, avec leur cause probable. */
  view(trusted: (p: string) => boolean | null): { id: string; at: number; cwd: string; prompt: string; worktree: boolean; trust: boolean; cause: string }[] {
    const now = this.now();
    return this.list().filter((l) => isLate(l, now)).sort((a, b) => b.at - a.at).map((l) => {
      const c = probableCause(l, l.worktree ? false : trusted(l.cwd));
      return { id: l.id, at: l.at, cwd: l.cwd, prompt: l.prompt, worktree: l.worktree, trust: c.trust, cause: c.text };
    });
  }
}
