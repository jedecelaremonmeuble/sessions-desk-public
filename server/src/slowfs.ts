// LECTURES QUI NE FIGENT PAS LE SERVEUR.
//
// Constat (trace de stall.ts) : ouvrir un fichier peut attendre plusieurs secondes — même un fichier de quelques
// octets — quand l'antivirus est saturé, et les fichiers que le serveur relit chaque seconde sont justement ceux que
// d'autres processus réécrivent sans cesse. Une ouverture synchrone fige alors tout le serveur.
//
// Ici, l'ouverture est faite par un FIL DE LECTURE, et le fil principal ne l'attend que `deadlineMs` :
//  - mode « stale » (petits fichiers d'état) : passé le délai, la valeur PRÉCÉDENTE est rendue ; la lecture finit en
//    arrière-plan. Tant qu'elle n'a pas fini, `staleStamp` rend la date et la taille de la valeur rendue : un cache
//    fondé sur la date du fichier ne retient donc jamais un contenu périmé sous une date neuve ;
//  - mode « late » (gros fichiers, dont rien n'est gardé) : passé le délai, rien n'est rendu (undefined) et
//    l'appelant garde ce qu'il avait ; le résultat arrivé en retard est rendu à l'appel suivant.
// Sans valeur précédente, ou tous les fils occupés et rien à rendre : lecture directe, bloquante, comme avant.
// Garde éteinte (tests, scripts) : lecture directe dans le fil appelant, même code de lecture.
import fs from 'node:fs';
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads';
import { perfLine } from './stall.ts';

/** read : tout le fichier · tail : les n derniers octets · head : les n premiers · range : de l'octet n à la fin. */
export type ReadOp = 'read' | 'tail' | 'head' | 'range';
/** Contenu lu et état du fichier AU MOMENT de la lecture (même descripteur) ; `from` : premier octet rendu. */
export interface ReadResult { size: number; mtimeMs: number; birthtimeMs: number; from: number; buf: Uint8Array }
type Fs = typeof fs;

const MAX_BYTES = 64 * 1024 * 1024;    // par lecture ; la suite d'un fichier plus gros se lit à l'appel suivant (range)

/** La lecture elle-même (fil de lecture ou fil appelant) ; null si le fichier est absent ou illisible. */
function readNow(f: Fs, op: ReadOp, path: string, n: number, max: number): ReadResult | null {
  let fd: number;
  try { fd = f.openSync(path, 'r'); } catch { return null; }
  try {
    const st = f.fstatSync(fd); const size = st.size;
    let from = 0, len = size;
    if (op === 'tail') { len = Math.min(size, n); from = size - len; }
    else if (op === 'head') len = Math.min(size, n);
    else if (op === 'range') { from = n <= size ? n : 0; len = size - from; }   // fichier réécrit plus court : du début
    len = Math.min(len, max);
    const buf = new Uint8Array(len);
    let got = 0;
    while (got < len) { const r = f.readSync(fd, buf, got, len - got, from + got); if (r <= 0) break; got += r; }
    return { size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, from, buf: got === len ? buf : buf.subarray(0, got) };
  } catch { return null; } finally { try { f.closeSync(fd); } catch { /* déjà fermé */ } }
}

// Fil de lecture, en JavaScript simple : une demande à la fois, réponse sur le port puis drapeau levé (le fil
// principal attend le drapeau, puis prend la réponse sans rendre la main : receiveMessageOnPort).
const WORKER = `
const { workerData: w } = require('node:worker_threads'); const fs = require('node:fs');
const flag = new Int32Array(w.flag);
w.port.on('message', (m) => {
  if (w.delay && m.path.includes(w.delay.match)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, w.delay.ms);
  let r = null; try { r = readNow(fs, m.op, m.path, m.n, ${MAX_BYTES}); } catch {}
  if (r && r.buf.byteLength !== r.buf.buffer.byteLength) r.buf = r.buf.slice();
  w.port.postMessage({ id: m.id, r }, r ? [r.buf.buffer] : []);
  Atomics.store(flag, 0, 1); Atomics.notify(flag, 0);
});
`;

interface Job { id: number; key: string; op: ReadOp; path: string; mode: 'stale' | 'late'; at: number }
interface Slot { w: Worker; port: MessagePort; flag: Int32Array; job: Job | null; dead: boolean }
export interface ReadGuardOptions {
  /** Journal de performance où noter les lectures lentes (stall.ts). */
  file?: string;
  deadlineMs?: number;
  workers?: number;
  /** Essais : les fichiers dont le chemin contient `match` mettent `ms` de plus à s'ouvrir. */
  delay?: { match: string; ms: number };
}

const KEEP_BYTES = 2 * 1024 * 1024;    // au-delà, rien n'est gardé : sans valeur précédente, la lecture bloque
const KEEP_MAX = 4000, LATE_MAX = 32;
const BLOCK_MS = 30_000;               // attente d'un fil sans valeur à rendre, avant de lire soi-même

let slots: Slot[] | null = null;
let deadline = 100; let logFile: string | null = null; let nextId = 1;
const kept = new Map<string, ReadResult | null>();
const late = new Map<string, ReadResult | null>();
const flying = new Set<string>();
const stale = new Map<string, ReadResult | null>();   // chemin → valeur rendue périmée, lecture en cours

const keyOf = (op: ReadOp, path: string, n: number): string => `${op}|${n}|${path}`;
function keep(key: string, r: ReadResult | null): void {
  kept.delete(key);
  if (r && r.buf.byteLength > KEEP_BYTES) return;
  kept.set(key, r);
  if (kept.size > KEEP_MAX) for (const k of kept.keys()) { kept.delete(k); if (kept.size <= KEEP_MAX * 0.9) break; }
}
function log(msg: string): void { if (logFile) perfLine(logFile, msg); }

/** Prend la réponse d'un fil dont le drapeau est levé ; null si elle n'est pas là. */
function take(s: Slot): { id: number; r: ReadResult | null } | null {
  if (Atomics.load(s.flag, 0) !== 1) return null;
  const m = receiveMessageOnPort(s.port);
  return m ? m.message as { id: number; r: ReadResult | null } : null;
}
/** Range les lectures finies en retard : la valeur gardée est rafraîchie (stale) ou mise de côté pour le prochain appel (late). */
function settle(): void {
  if (!slots || !flying.size) return;
  for (const s of slots) {
    const j = s.job; if (!j) continue;
    // Fil mort avec une lecture en cours : elle ne finira pas ; la prochaine demande repartira d'un autre fil.
    if (s.dead) { s.job = null; flying.delete(j.key); stale.delete(j.path); continue; }
    const m = take(s); if (!m || m.id !== j.id) continue;
    s.job = null; flying.delete(j.key);
    if (j.mode === 'stale') { keep(j.key, m.r); stale.delete(j.path); }
    else { late.set(j.key, m.r); if (late.size > LATE_MAX) late.delete(late.keys().next().value!); }
    log(`lecture lente finie : ${j.op} ${j.path} : ${Date.now() - j.at} ms`);
  }
}

/** Date et taille à croire pour ce fichier tant qu'une valeur périmée en a été rendue : celles de CETTE valeur
 *  (null : fichier alors absent). undefined : rien de périmé, lire le disque. */
export function staleStamp(path: string): { mtimeMs: number; size: number } | null | undefined {
  if (!stale.size) return undefined;
  settle();
  const r = stale.get(path);
  return r === undefined ? undefined : r;
}

/**
 * Lit un fichier sans figer le fil principal plus de `deadlineMs`. Rend le résultat, null (absent ou illisible), ou —
 * en mode « late » seulement — undefined : pas de réponse à temps, à redemander.
 */
export function guardedRead(op: ReadOp, path: string, n: number, mode: 'stale' | 'late'): ReadResult | null | undefined {
  if (!slots) return readNow(fs, op, path, n, MAX_BYTES);
  settle();
  const key = keyOf(op, path, n);
  if (mode === 'late' && late.has(key)) { const r = late.get(key)!; late.delete(key); return r; }
  if (flying.has(key)) return mode === 'late' ? undefined : kept.get(key) ?? null;
  const s = slots.find((x) => !x.job && !x.dead);
  const has = mode === 'stale' && kept.has(key);
  if (!s) {
    if (mode === 'late') return undefined;
    if (has) { stale.set(path, kept.get(key)!); return kept.get(key)!; }
    return readNow(fs, op, path, n, MAX_BYTES);
  }
  const id = nextId++; const at = Date.now();
  Atomics.store(s.flag, 0, 0);
  s.port.postMessage({ id, op, path, n });
  // Sans valeur à rendre (mode stale, première lecture) : on attend le fil, comme une lecture directe aurait attendu.
  const wait = mode === 'late' || has ? deadline : BLOCK_MS;
  Atomics.wait(s.flag, 0, 0, wait);
  const m = take(s);
  if (m && m.id === id) { if (mode === 'stale') { keep(key, m.r); stale.delete(path); } return m.r; }
  s.job = { id, key, op, path, mode, at }; flying.add(key);
  if (mode === 'late') { log(`lecture lente : ${op} ${path} : pas de réponse après ${wait} ms, remise au tour suivant`); return undefined; }
  if (has) { stale.set(path, kept.get(key)!); log(`lecture lente : ${op} ${path} : pas de réponse après ${wait} ms, valeur précédente gardée`); return kept.get(key)!; }
  // Fil muet et rien à rendre : il est écarté, et la lecture est faite ici.
  s.dead = true; flying.delete(key); s.job = null;
  log(`lecture lente : ${op} ${path} : fil de lecture muet après ${wait} ms, lecture directe`);
  return readNow(fs, op, path, n, MAX_BYTES);
}

export interface ReadGuard { stop(): Promise<void> }
/** Démarre les fils de lecture (serveur seulement). Ne retient jamais le process. */
export function startReadGuard(o: ReadGuardOptions = {}): ReadGuard {
  if (slots) throw new Error('garde de lecture déjà démarrée');
  deadline = o.deadlineMs ?? 100; logFile = o.file ?? null;
  const made: Slot[] = [];
  for (let i = 0; i < (o.workers ?? 4); i++) {
    const { port1, port2 } = new MessageChannel();
    const flag = new SharedArrayBuffer(4);
    const w = new Worker(`const readNow = ${readNow.toString()};\n${WORKER}`, { eval: true, workerData: { port: port2, flag, delay: o.delay ?? null }, transferList: [port2] });
    const s: Slot = { w, port: port1, flag: new Int32Array(flag), job: null, dead: false };
    w.on('error', () => { s.dead = true; }); w.on('exit', () => { s.dead = true; });
    w.unref(); port1.unref();
    made.push(s);
  }
  slots = made;
  return {
    async stop() {
      if (slots === made) { slots = null; kept.clear(); late.clear(); flying.clear(); stale.clear(); logFile = null; }
      await Promise.all(made.map((s) => { s.port.close(); return s.w.terminate(); }));
    },
  };
}
