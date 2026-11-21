// Client du pilote .NET (driver/).
//
// Le pilote est un process RÉSIDENT : une requête JSON par ligne sur son stdin, une réponse par ligne sur son stdout,
// dans l'ordre où elles finissent (d'où l'id). Ce client :
//  - le lance à la première requête, sans fenêtre (windowsHide) ; le pilote lâche aussitôt sa console (FreeConsole) ;
//  - donne à chaque requête un délai maximum (par opération) ; au-delà, le pilote est réputé FIGÉ — une session
//    Windows morte fige user32, voir reference_lanceur_session_windows_morte — : il est TUÉ, toutes les requêtes en
//    cours échouent, et le suivant est relancé à la requête d'après. Le serveur ne se fige jamais avec lui ;
//  - relance le pilote mort (plantage, sortie) à la requête suivante, avec un délai croissant s'il meurt en boucle ;
//  - met en attente les requêtes reçues pendant un démarrage (elles partent dès que le process est lancé : le tube
//    garde ce qui est écrit avant que le pilote ne lise).

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Codes de retour de send / sendKeys, ceux de ConScreen. */
export const SendCode = { Sent: 0, Inaccessible: 2, UnknownKey: 3, PromptNotEmpty: 5 } as const;
/** Codes de retour de focus, ceux de focus-session.ps1. */
export const FocusCode = { Ok: 0, Inaccessible: 2, TabNotFound: 3 } as const;

export interface DriverOps {
  ping: { args: Record<string, never>; result: { version: string; pid: number } };
  title: { args: { pid: number }; result: string | null };
  foregroundTitle: { args: Record<string, never>; result: string | null };
  idleSeconds: { args: Record<string, never>; result: number };
  read: { args: { pid: number }; result: string | null };
  suggestion: { args: { pid: number }; result: string | null };
  send: { args: { pid: number; line: string }; result: number };
  /** Élément « \u0001Nom » = touche nommée (Enter, Esc, Up, Down, Left, Right, Tab, ShiftTab, Space, Backspace), sinon texte tapé. */
  sendKeys: { args: { pid: number; items: string[] }; result: number };
  focus: { args: { pid: number; noActivate?: boolean }; result: number };
  /** Arguments de wt.exe, en une chaîne (comme Start-Process -ArgumentList). */
  wt: { args: { args: string }; result: { pid: number | null } };
  toast: { args: { title: string; text: string; launch: string }; result: true };
}
export type DriverOp = keyof DriverOps;

/** Délais maximum par opération (ms). sendKeys : jusqu'à 20 éléments × 500 ms ; focus : 12 × 200 ms + UI Automation. */
export const DEFAULT_TIMEOUTS: Record<string, number> = {
  ping: 5_000, title: 5_000, foregroundTitle: 5_000, idleSeconds: 5_000, read: 5_000, suggestion: 5_000,
  send: 10_000, sendKeys: 20_000, focus: 15_000, wt: 10_000, toast: 10_000,
};
const FALLBACK_TIMEOUT = 10_000;

export class DriverError extends Error {
  readonly kind: 'timeout' | 'died' | 'op' | 'closed';
  constructor(message: string, kind: DriverError['kind']) { super(message); this.name = 'DriverError'; this.kind = kind; }
}

export interface DriverOptions {
  exe: string;
  args?: string[];
  timeouts?: Record<string, number>;
  /** Journal (stderr du pilote, relances, délais dépassés). */
  log?: (line: string) => void;
}

interface Pending { op: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export class DriverClient {
  #proc: ChildProcess | null = null;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;
  #deaths: number[] = [];       // dates des morts récentes, pour espacer les relances
  #notBefore = 0;
  /** Nombre de lancements du pilote (1 = jamais relancé). */
  starts = 0;

  readonly options: DriverOptions;
  constructor(options: DriverOptions) { this.options = options; }

  get pid(): number | undefined { return this.#proc?.pid; }

  call<K extends DriverOp>(op: K, args: DriverOps[K]['args'], timeoutMs?: number): Promise<DriverOps[K]['result']>;
  call(op: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  call(op: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    if (this.#closed) return Promise.reject(new DriverError('pilote fermé', 'closed'));
    const ms = timeoutMs ?? this.options.timeouts?.[op] ?? DEFAULT_TIMEOUTS[op] ?? FALLBACK_TIMEOUT;
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#onTimeout(id), ms);
      this.#pending.set(id, { op, resolve, reject, timer });
      const wait = this.#notBefore - Date.now();
      if (wait > 0) setTimeout(() => this.#write(id, op, args), wait);
      else this.#write(id, op, args);
    });
  }

  /** Arrête le pilote (fin du serveur). Les requêtes en cours échouent. */
  close(): void {
    this.#closed = true;
    this.#kill('pilote fermé', 'closed');
  }

  #write(id: number, op: string, args: Record<string, unknown>): void {
    if (!this.#pending.has(id)) return;          // déjà expirée pendant l'attente
    const p = this.#ensure();
    if (!p?.stdin?.writable) { this.#fail(id, new DriverError('pilote injoignable', 'died')); return; }
    p.stdin.write(JSON.stringify({ id, op, args }) + '\n');
  }

  #ensure(): ChildProcess | null {
    if (this.#proc) return this.#proc;
    if (this.#closed) return null;
    const p = spawn(this.options.exe, this.options.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.#proc = p;
    this.starts++;
    p.stdin.on('error', () => {});               // EPIPE si le pilote meurt pendant une écriture : géré par 'exit'
    createInterface({ input: p.stdout }).on('line', (l) => this.#onLine(l));
    createInterface({ input: p.stderr }).on('line', (l) => this.options.log?.(`[pilote] ${l}`));
    p.on('error', (e) => this.#onExit(p, `lancement impossible : ${e.message}`));
    p.on('exit', (code, sig) => this.#onExit(p, `pilote arrêté (code ${code ?? sig})`));
    return p;
  }

  #onLine(line: string): void {
    let msg: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
    try { msg = JSON.parse(line); } catch { this.options.log?.(`[pilote] ligne illisible : ${line.slice(0, 200)}`); return; }
    if (typeof msg.id !== 'number') { this.options.log?.(`[pilote] réponse sans id : ${line.slice(0, 200)}`); return; }
    const p = this.#pending.get(msg.id);
    if (!p) return;                               // arrivée après son délai
    this.#pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok === true) p.resolve(msg.result ?? null);
    else p.reject(new DriverError(String(msg.error ?? 'erreur du pilote'), 'op'));
  }

  #onTimeout(id: number): void {
    const p = this.#pending.get(id);
    if (!p) return;
    this.options.log?.(`[pilote] ${p.op} : délai dépassé, pilote tué et relancé à la prochaine requête`);
    this.#fail(id, new DriverError(`pilote : délai dépassé (${p.op})`, 'timeout'));
    // Un pilote qui ne répond pas dans le délai est réputé figé : les autres requêtes ne répondraient pas non plus.
    this.#kill('pilote relancé (une requête a dépassé son délai)', 'died');
  }

  #onExit(p: ChildProcess, why: string): void {
    if (this.#proc !== p) return;
    this.#proc = null;
    const now = Date.now();
    this.#deaths = [...this.#deaths.filter((t) => now - t < 30_000), now];
    // Morts en boucle : 0, puis 250 ms, 500 ms… jusqu'à 5 s entre deux lancements.
    const n = this.#deaths.length;
    this.#notBefore = n <= 1 ? 0 : now + Math.min(5_000, 250 * 2 ** (n - 2));
    if (!this.#closed) this.options.log?.(`[pilote] ${why}`);
    for (const id of [...this.#pending.keys()]) this.#fail(id, new DriverError(why, this.#closed ? 'closed' : 'died'));
  }

  #kill(why: string, kind: DriverError['kind']): void {
    const p = this.#proc;
    if (!p) return;
    this.#proc = null;
    for (const id of [...this.#pending.keys()]) this.#fail(id, new DriverError(why, kind));
    try { p.kill(); } catch { /* déjà mort */ }
  }

  #fail(id: number, e: Error): void {
    const p = this.#pending.get(id);
    if (!p) return;
    this.#pending.delete(id);
    clearTimeout(p.timer);
    p.reject(e);
  }
}
