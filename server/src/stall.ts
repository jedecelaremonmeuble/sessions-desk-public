// TRACE DE PERFORMANCE du serveur : durée de chaque phase du démarrage, et gels de la boucle d'événements.
//
// Un gel se voit de l'EXTÉRIEUR de la boucle : un fil de travail (worker) lit un battement que le fil principal écrit
// toutes les 250 ms dans une mémoire partagée. Il écrit donc même pendant un gel qui ne finit jamais, là où un minuteur
// du fil principal ne se réveillerait qu'après. Pour chaque gel, il note la dernière PHASE annoncée par le fil
// principal et le CPU consommé par le process pendant le gel :
//   - CPU ≈ durée du gel : le serveur CALCULAIT (notre code est en cause) ;
//   - CPU ≈ 0 : le serveur ATTENDAIT (disque, antivirus, machine saturée), pas notre code.
//
// La phase ne dit pas QUEL appel attend. Le fil principal note donc aussi, dans la même mémoire partagée, l'appel
// SYNCHRONE en cours (lecture d'un fichier, lancement d'un programme) : un gel le désigne, avec le fichier ou la
// commande. Un gel sans appel en cours est lui aussi une réponse : le process attendait ailleurs que dans ces appels.
// Un appel synchrone lent mais sous le seuil du gel a sa propre ligne (« appel lent »).
// Fichier : <temp>\sessions-desk-node-<port>.perf.log, une ligne par événement, mis de côté (.old) au-delà de 1 Mo.
import childProcess from 'node:child_process';
import fs, { appendFileSync, renameSync, statSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Worker } from 'node:worker_threads';

/** Phases annoncées par le fil principal : c'est la dernière annoncée qu'un gel désigne. */
export const PHASES = ['démarrage', 'état', 'veille', 'fermées', 'attente', 'requête', 'index', 'recherche'] as const;
export type Phase = typeof PHASES[number];

// Mémoire partagée : battement (0), phase (8), longueur du texte de l'appel en cours (12, 0 = aucun), son début (16),
// son texte en UTF-8 (24…).
const OP_BYTES = 360;
const sab = new SharedArrayBuffer(24 + OP_BYTES);
const beat = new Float64Array(sab, 0, 1);
const phase = new Int32Array(sab, 8, 1);
const opLen = new Int32Array(sab, 12, 1);
const opAt = new Float64Array(sab, 16, 1);
const opText = Buffer.from(sab, 24, OP_BYTES);
beat[0] = Date.now();

/** Annonce ce que fait le fil principal (coût : une écriture en mémoire partagée). */
export function setPhase(p: Phase): void { Atomics.store(phase, 0, PHASES.indexOf(p)); }

/** Verdict d'un gel à partir du CPU consommé pendant sa durée. */
export function stallVerdict(wallMs: number, cpuMs: number): string {
  const r = wallMs > 0 ? cpuMs / wallMs : 0;
  if (r >= 0.6) return 'le serveur calculait (code)';
  if (r <= 0.2) return 'le serveur attendait (disque, antivirus ou machine, pas le code)';
  return 'calcul et attente mêlés';
}

/** Ligne de démarrage : durée de chaque phase, total, CPU ; « LENT » au-delà de slowMs. */
export function startupLine(steps: [string, number][], totalMs: number, cpuMs: number, slowMs = 5000): string {
  const parts = steps.map(([n, ms]) => `${n} ${Math.round(ms)} ms`).join(' · ');
  return `démarrage${totalMs >= slowMs ? ' LENT' : ''} : ${parts} · total ${Math.round(totalMs)} ms (CPU ${Math.round(cpuMs)} ms, ${stallVerdict(totalMs, cpuMs)})`;
}

// L'écriture du journal n'est pas suivie (depth) : sinon une ligne « appel lent » en écrirait une autre, sans fin.
export function perfLine(file: string, msg: string): void {
  depth++;
  try { appendFileSync(file, `${new Date().toISOString().slice(0, 19)} ${msg}\r\n`, 'utf8'); } catch { /* idem */ } finally { depth--; }
}

// ───────────── appel synchrone en cours ─────────────
/** Appels suivis : ceux qui rendent la main seulement quand le disque ou Windows a répondu. */
const FS_OPS = ['statSync', 'lstatSync', 'fstatSync', 'existsSync', 'readFileSync', 'readdirSync', 'openSync', 'readSync', 'closeSync',
  'writeFileSync', 'appendFileSync', 'renameSync', 'mkdirSync', 'mkdtempSync', 'rmSync', 'unlinkSync', 'copyFileSync'] as const;
const PROC_OPS = ['spawn', 'execFile', 'spawnSync', 'execFileSync'] as const;   // lancer un programme est synchrone sous Windows

type Fn = (...a: unknown[]) => unknown;
let depth = 0;                              // un appel suivi qui en appelle un autre : seul le premier compte
let slowFile: string | null = null; let slowMs = 500;
const fds = new Map<number, string>();      // descripteur → fichier, pour nommer readSync / closeSync

/** Ce sur quoi porte l'appel : le fichier (ou celui du descripteur), ou la commande. La FIN d'un chemin long est gardée. */
export function opTarget(arg: unknown): string {
  let t = typeof arg === 'number' ? fds.get(arg) ?? `descripteur ${arg}` : typeof arg === 'string' ? arg : arg instanceof URL || Buffer.isBuffer(arg) ? String(arg) : '';
  t = t.replace(/[\r\n]+/g, ' ');
  return t.length > 100 ? '…' + t.slice(-100) : t;
}
function beginOp(name: string, target: string): void {
  Atomics.store(opLen, 0, 0);               // le guetteur ne lit jamais un texte à moitié écrit
  const n = opText.write(`${name} ${target}`, 'utf8');
  opAt[0] = Date.now();
  Atomics.store(opLen, 0, n);
}
function endOp(name: string, target: string, ms: number): void {
  Atomics.store(opLen, 0, 0);
  if (slowFile !== null && ms >= slowMs) perfLine(slowFile, `appel lent : ${name} ${target} : ${Math.round(ms)} ms`);
}
/** Enveloppe un appel synchrone : annoncé au guetteur tant qu'il dure, noté s'il a été lent. */
export function tracked<F>(name: string, f: F): F {
  const g = function (this: unknown, ...a: unknown[]): unknown {
    if (depth > 0) return (f as Fn).apply(this, a);
    // Un programme : la commande et le DÉBUT de ses arguments (le script lancé), pas la fin.
    const target = Array.isArray(a[1]) ? `${String(a[0])} ${a[1].join(' ')}`.replace(/[\r\n]+/g, ' ').slice(0, 100) : opTarget(a[0]);
    depth++; beginOp(name, target);
    const t = performance.now();
    try {
      const r = (f as Fn).apply(this, a);
      if (name === 'openSync' && typeof r === 'number') fds.set(r, target);
      return r;
    } finally {
      depth--;
      if (name === 'closeSync' && typeof a[0] === 'number') fds.delete(a[0]);
      endOp(name, target, performance.now() - t);
    }
  };
  // Propriétés de l'original gardées (execFile porte sa version « promisify », par exemple).
  Object.defineProperties(g, Object.getOwnPropertyDescriptors(f));
  return g as F;
}
let traced = false;
/** Suit les appels synchrones de TOUT le serveur : les fonctions de node:fs et node:child_process sont enveloppées
 *  à la source, et les imports nommés déjà faits par les autres modules suivent (syncBuiltinESMExports). Une fois. */
export function traceSyncOps(): void {
  if (traced) return; traced = true;
  const wrap = (mod: Record<string, unknown>, names: readonly string[]): void => {
    for (const n of names) if (typeof mod[n] === 'function') mod[n] = tracked(n, mod[n]);
  };
  wrap(fs as unknown as Record<string, unknown>, FS_OPS);
  wrap(childProcess as unknown as Record<string, unknown>, PROC_OPS);
  syncBuiltinESMExports();
}

function rotate(file: string): void {
  try { if (statSync(file).size > 1 << 20) renameSync(file, file + '.old'); } catch { /* absent */ }
}

// Le fil de travail, en JavaScript simple (évalué) : rien à charger, rien qui puisse lui-même attendre le fil principal.
const WORKER = `
const { workerData: w } = require('node:worker_threads'); const fs = require('node:fs');
const beat = new Float64Array(w.sab, 0, 1); const phase = new Int32Array(w.sab, 8, 1);
const opLen = new Int32Array(w.sab, 12, 1); const opAt = new Float64Array(w.sab, 16, 1); const opText = new Uint8Array(w.sab, 24);
// L'appel synchrone que le fil principal a annoncé et pas encore fini : lu pendant le gel, donc stable.
const op = (now) => { const n = Atomics.load(opLen, 0); return n > 0 ? 'appel en cours depuis ' + Math.round(now - opAt[0]) + ' ms : ' + Buffer.from(opText.slice(0, n)).toString('utf8') : 'aucun appel synchrone suivi en cours'; };
const log = (m) => { try { fs.appendFileSync(w.file, new Date().toISOString().slice(0, 19) + ' ' + m + '\\r\\n', 'utf8'); } catch {} };
const ms = (u) => (u.user + u.system) / 1000;
let okCpu = process.cpuUsage(), okAt = Date.now(), stall = null;
setInterval(() => {
  const now = Date.now(), age = now - beat[0];
  if (!stall) {
    // Repère CPU pris seulement sur un battement FRAIS : sous le seuil, un gel peut déjà avoir commencé, et un repère
    // pris pendant le gel en sous-compterait la durée et le CPU (vu en production : « CPU 563 ms sur 1016 ms » pour 2,7 s).
    if (age <= w.freshMs) { okCpu = process.cpuUsage(); okAt = now; }
    if (age <= w.threshold) return;
    stall = { from: beat[0], cpu: okCpu, cpuAt: okAt, phase: w.phases[Atomics.load(phase, 0)] ?? '?', told: now };
    stall.op = op(now);
    log('boucle figée depuis ' + age + ' ms (phase ' + stall.phase + ') ; ' + stall.op);
    return;
  }
  const cpuMs = ms(process.cpuUsage(stall.cpu)), wall = now - stall.cpuAt;
  if (age <= w.threshold) {
    log('boucle débloquée après ' + (beat[0] - stall.from) + ' ms (phase ' + stall.phase + ') : CPU ' + Math.round(cpuMs) + ' ms sur ' + wall + ' ms, ' + verdict(wall, cpuMs) + ' ; au début du gel : ' + stall.op);
    stall = null; okCpu = process.cpuUsage(); okAt = now;
  } else if (now - stall.told >= w.repeatMs) {
    stall.told = now;
    log('boucle toujours figée depuis ' + age + ' ms (phase ' + stall.phase + ') : CPU ' + Math.round(cpuMs) + ' ms sur ' + wall + ' ms, ' + verdict(wall, cpuMs) + ' ; ' + op(now));
  }
}, w.everyMs);
`;

export interface StallWatch { stop(): Promise<void> }

/** Démarre le battement (fil principal) et le guetteur (fil de travail). Ne retient jamais le process. */
export function startStallWatch(file: string, o: { thresholdMs?: number; everyMs?: number; beatMs?: number; repeatMs?: number; slowOpMs?: number } = {}): StallWatch {
  rotate(file);
  slowFile = file; slowMs = o.slowOpMs ?? 500;
  const beatMs = o.beatMs ?? 250;
  beat[0] = Date.now();
  const t = setInterval(() => { beat[0] = Date.now(); }, beatMs); t.unref();
  // Le verdict est injecté dans le worker depuis sa source : une seule définition des seuils.
  const w = new Worker(`const verdict = ${stallVerdict.toString()};\n${WORKER}`, {
    eval: true,
    workerData: { sab, file, phases: [...PHASES], threshold: o.thresholdMs ?? 2000, freshMs: 2 * beatMs, everyMs: o.everyMs ?? 500, repeatMs: o.repeatMs ?? 60_000 },
  });
  w.unref();
  w.on('error', () => undefined);
  return { async stop() { clearInterval(t); if (slowFile === file) slowFile = null; await w.terminate(); } };
}
