// AUTRES POSTES DU MÊME PROPRIÉTAIRE (clé `peers` de config.json) : leurs sessions dans la liste de celui-ci.
//
// Chaque poste fait tourner son propre serveur, servi sur le tailnet par `tailscale serve`, qui ne répond à distance
// qu'à son propriétaire (http.ts). Ce module s'appuie sur cet accès, DE SERVEUR À SERVEUR : aucun secret, aucun port
// de plus. Il lit l'état des pairs (`/api/state`) tant qu'une page le demande, et relaie vers un pair une LISTE FERMÉE
// de routes : lire un écran, une conversation ; répondre. Fermer, relancer, lancer une session ne sont pas relayés —
// et le pair applique de toute façon ses propres refus à distance.
//
// Rien n'est recopié : favoris, tags, transcripts restent sur le poste qui porte la session. Un pair injoignable
// (éteint, en veille) est un état normal : il est dit, il ne ralentit rien (lectures en parallèle, hors de la boucle).
import { T } from './i18n.ts';

/** Nom d'un poste sur le tailnet : une étiquette DNS. */
export const PEER_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
export const MAX_PEERS = 8;
/** Routes relayées : `/api/peer/<poste>/<route>` ⇒ `/api/<route>` du pair. Rien d'autre. */
export const PEER_GET = new Set(['screen', 'transcript', 'commands', 'image']);
export const PEER_POST = new Set(['send', 'keys', 'ack']);
/** En-tête posé sur tout appel fait à un pair : un serveur ne relaie jamais une demande venue d'un autre serveur. */
export const PEER_HEADER = 'x-sd-peer';

const POLL_MS = 2000;          // rythme de lecture d'un pair, tant qu'une page regarde
const DEMAND_MS = 20_000;      // sans lecture d'état par une page depuis ce délai : plus aucun appel aux pairs
const FRESH_MS = 10_000;       // dernier état plus vieux : le pair est dit injoignable
const POLL_TIMEOUT_MS = 4000;
const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 30_000;
const MAX_ANSWER = 8 * 1024 * 1024;

/** Clé de premier niveau `peers` : noms de poste, sans doublon, en minuscules. Tout le reste est ignoré. */
export function parsePeers(raw: unknown): string[] {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).peers : undefined;
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const n = typeof x === 'string' ? x.trim().toLowerCase() : '';
    if (PEER_NAME.test(n) && !out.includes(n)) out.push(n);
  }
  return out.slice(0, MAX_PEERS);
}

/** Adresse d'un pair : le nom de CE poste sur le tailnet, première étiquette remplacée. null : identité inconnue,
 *  nom invalide, ou le poste lui-même. */
export function peerOrigin(name: string, selfOrigin: string | null): string | null {
  const m = /^https:\/\/([^./]+)\.([^/]+)$/i.exec(selfOrigin ?? '');
  if (!m || !PEER_NAME.test(name) || m[1]!.toLowerCase() === name) return null;
  return `https://${name}.${m[2]!.toLowerCase()}`;
}

/** `/api/peer/<poste>/<route>` ⇒ poste et route ; null si le chemin n'a pas cette forme. */
export function peerRoute(path: string): { name: string; op: string } | null {
  const m = /^\/api\/peer\/([^/]+)\/([a-z]+)$/.exec(path);
  return m ? { name: m[1]!.toLowerCase(), op: m[2]! } : null;
}

/** Sessions d'un pair telles que la page les reçoit : celles qui ont un terminal, marquées du nom du poste, leurs
 *  dates ramenées à l'horloge de CE poste (deux postes n'ont pas la même heure à la seconde). */
export function peerSessions(name: string, state: unknown, now: number): Record<string, unknown>[] {
  const st = state && typeof state === 'object' ? state as { now?: unknown; sessions?: unknown } : {};
  if (!Array.isArray(st.sessions)) return [];
  const skew = typeof st.now === 'number' && Number.isFinite(st.now) ? now - st.now : 0;
  const out: Record<string, unknown>[] = [];
  for (const s of st.sessions as unknown[]) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
    const r = s as Record<string, unknown>;
    if (r.headless || typeof r.sessionId !== 'string' || typeof r.pid !== 'number') continue;
    const o: Record<string, unknown> = { ...r, machine: name };
    for (const k of ['statusSince', 'startedAt', 'createdAt']) if (typeof r[k] === 'number' && r[k]) o[k] = (r[k] as number) + skew;
    out.push(o);
  }
  return out;
}

export interface PeerView {
  name: string;
  /** Lu il y a moins de 10 s. */
  ok: boolean;
  /** Dernière lecture réussie (ms, horloge de ce poste) ; 0 : jamais depuis le démarrage. */
  at: number;
  error: string | null;
  sessions: Record<string, unknown>[];
}
export interface Forwarded { status: number; type: string; body: Buffer }
type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
interface Slot { at: number; error: string | null; sessions: Record<string, unknown>[]; tried: number; busy: boolean }

export class Peers {
  readonly names: string[];
  readonly #self: () => string | null;
  readonly #fetch: FetchFn;
  readonly #slots = new Map<string, Slot>();
  #demand = 0;

  constructor(names: string[], selfOrigin: () => string | null, fetchFn: FetchFn = (u, i) => fetch(u, i)) {
    this.names = names; this.#self = selfOrigin; this.#fetch = fetchFn;
    for (const n of names) this.#slots.set(n, { at: 0, error: null, sessions: [], tried: 0, busy: false });
  }
  get enabled(): boolean { return this.names.length > 0; }
  has(name: string): boolean { return this.#slots.has(name); }

  /** Une page vient de lire l'état : les pairs sont lus pendant les 20 s qui suivent. */
  touch(now: number): void { this.#demand = now; }

  /** Lance les lectures dues. Ne bloque jamais : une lecture en cours n'est pas doublée. */
  tick(now: number): Promise<void>[] {
    if (!this.enabled || now - this.#demand > DEMAND_MS) return [];
    const runs: Promise<void>[] = [];
    for (const [name, s] of this.#slots) {
      if (s.busy || now - s.tried < POLL_MS) continue;
      s.busy = true; s.tried = now;
      runs.push(this.#poll(name, s).finally(() => { s.busy = false; }));
    }
    return runs;
  }
  async #poll(name: string, s: Slot): Promise<void> {
    const origin = peerOrigin(name, this.#self());
    if (!origin) { s.error = this.#self() === null ? T('identité Tailscale de ce poste inconnue', 'Tailscale identity of this machine unknown') : T('nom de poste refusé', 'machine name refused'); s.sessions = []; return; }
    try {
      const r = await this.#fetch(`${origin}/api/state`, { headers: { [PEER_HEADER]: '1' }, signal: AbortSignal.timeout(POLL_TIMEOUT_MS), redirect: 'error' });
      if (!r.ok) { s.error = r.status === 403 ? T('accès refusé par ce poste (403)', 'access refused by that machine (403)') : T(`réponse ${r.status}`, `answer ${r.status}`); s.sessions = []; return; }
      const now = Date.now();
      s.sessions = peerSessions(name, await r.json(), now); s.at = now; s.error = null;
    } catch (e) { s.error = unreachable(e); s.sessions = []; }
  }

  view(now: number): PeerView[] {
    return this.names.map((name) => {
      const s = this.#slots.get(name)!; const ok = s.at > 0 && now - s.at <= FRESH_MS && s.error === null;
      return { name, ok, at: s.at, error: ok ? null : s.error, sessions: ok ? s.sessions : [] };
    });
  }

  /** Relaie une requête vers un pair. L'appelant a déjà vérifié le nom, la route et le droit d'écrire. */
  async forward(name: string, op: string, method: 'GET' | 'POST', query: string, body: string, lang: string | undefined): Promise<Forwarded> {
    const fail = (status: number, error: string): Forwarded => ({ status, type: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ error })) });
    const origin = peerOrigin(name, this.#self());
    if (!origin) return fail(502, T('poste injoignable : identité Tailscale inconnue', 'machine unreachable: Tailscale identity unknown'));
    const headers: Record<string, string> = { [PEER_HEADER]: '1' };
    if (lang) headers['x-sd-lang'] = lang;
    // Écriture : le pair n'accepte une action à distance que si elle porte SON origine (http.ts, writeOk).
    if (method === 'POST') { headers.origin = origin; headers['content-type'] = 'application/json'; }
    try {
      const r = await this.#fetch(`${origin}/api/${op}${query ? `?${query}` : ''}`, { method, headers, ...(method === 'POST' ? { body } : {}),
        signal: AbortSignal.timeout(method === 'POST' ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS), redirect: 'error' });
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_ANSWER) return fail(502, T('réponse du poste trop grosse', 'answer from the machine too large'));
      return { status: r.status, type: r.headers.get('content-type') ?? 'application/json; charset=utf-8', body: buf };
    } catch (e) { return fail(502, T(`poste « ${name} » injoignable : ${unreachable(e)}`, `machine "${name}" unreachable: ${unreachable(e)}`)); }
  }
}

function unreachable(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return T('pas de réponse', 'no answer');
  return err?.cause?.code ?? err?.message ?? T('injoignable', 'unreachable');
}
