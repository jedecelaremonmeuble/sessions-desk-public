// Garde de lecture (slowfs.ts) : une ouverture de fichier qui traîne ne fige pas le fil appelant au-delà du délai.
// Les fichiers dont le nom contient « lent » mettent 800 ms de plus à s'ouvrir (option d'essai du fil de lecture).
import { appendFileSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { ScheduleScan } from '../src/scheduled.ts';
import { startReadGuard, type ReadGuard } from '../src/slowfs.ts';
import { fileSize, mtimeMs, readJson, readTail, readTailSoft, readText, transcriptCreatedAt } from '../src/util.ts';
import { sleep } from './parity/harness.ts';

const dir = mkdtempSync(join(tmpdir(), 'sd-slowfs-'));
const log = join(dir, 'perf.log');
const f = (n: string): string => join(dir, n);
const timed = <T>(fn: () => T): [T, number] => { const t = performance.now(); const v = fn(); return [v, performance.now() - t]; };
/** Écrit le fichier avec une date donnée : deux écritures de suite auraient sinon la même. */
const put = (p: string, text: string, at: number): void => { writeFileSync(p, text, 'utf8'); utimesSync(p, at / 1000, at / 1000); };

let guard: ReadGuard;
beforeAll(() => { guard = startReadGuard({ file: log, deadlineMs: 100, workers: 2, delay: { match: 'lent', ms: 800 } }); });
afterAll(async () => { await guard.stop(); rmSync(dir, { recursive: true, force: true }); });

test('fichier qui répond : contenu frais à chaque lecture, absent = undefined / null / []', () => {
  put(f('vite.json'), '{"v":1}', 1_700_000_000_000);
  expect(readJson(f('vite.json'))).toEqual({ v: 1 });
  put(f('vite.json'), '﻿{"v":2}', 1_700_000_001_000);
  expect(readJson(f('vite.json'))).toEqual({ v: 2 });
  expect(mtimeMs(f('vite.json'))).toBe(1_700_000_001_000);
  expect(readJson(f('absent.json'))).toBeUndefined();
  expect(readText(f('absent.json'))).toBeNull();
  expect(readTail(f('absent.jsonl'), 1024)).toEqual([]);
  expect(readTailSoft(f('absent.jsonl'), 1 << 20)).toEqual({ size: -1, lines: [] });
  writeFileSync(f('queue.jsonl'), 'tronquée\nb\n\nc\n');
  expect(readTail(f('queue.jsonl'), 6)).toEqual(['b', 'c']);                 // 1re ligne, coupée, sautée
  expect(readTailSoft(f('queue.jsonl'), 1 << 20)).toEqual({ size: 15, lines: ['tronquée', 'b', 'c'] });
});

test('petit fichier lent : la 1re lecture attend, les suivantes rendent la valeur précédente sans figer, avec SA date', async () => {
  const p = f('lent-etat.json');
  put(p, '{"v":1}', 1_700_000_000_000);
  const [v1, t1] = timed(() => readJson(p));
  expect(v1).toEqual({ v: 1 }); expect(t1).toBeGreaterThan(700);            // rien à rendre : on attend le disque
  put(p, '{"v":22}', 1_700_000_005_000);
  const [v2, t2] = timed(() => readJson(p));
  expect(v2).toEqual({ v: 1 }); expect(t2).toBeLessThan(400);               // délai passé : valeur précédente
  // Tant que la lecture n'a pas fini, date et taille sont celles de la valeur rendue : un cache par date ne retient
  // pas {v:1} sous la date neuve.
  expect(mtimeMs(p)).toBe(1_700_000_000_000); expect(fileSize(p)).toBe(7);
  const [v3, t3] = timed(() => readJson(p));
  expect(v3).toEqual({ v: 1 }); expect(t3).toBeLessThan(50);                // lecture déjà en cours : pas de 2e attente
  await sleep(1000);
  expect(mtimeMs(p)).toBe(1_700_000_005_000); expect(fileSize(p)).toBe(8);  // lecture finie : le disque fait foi
  expect(readJson(p)).toEqual({ v: 22 });
  await sleep(1000);
  const perf = readFileSync(log, 'utf8');
  expect(perf).toContain(`lecture lente : read ${p} : pas de réponse après 100 ms, valeur précédente gardée`);
  expect(perf).toMatch(/lecture lente finie : read .*lent-etat\.json : \d+ ms/);
});

test('gros fichier lent : rien de rendu au premier tour, le résultat arrivé en retard au tour suivant', async () => {
  const p = f('lent-transcript.jsonl');
  writeFileSync(p, '{"timestamp":"2026-01-02T03:04:05.000Z","a":1}\n{"b":2}\n');
  const [r1, t1] = timed(() => readTailSoft(p, 512 * 1024));
  expect(r1).toBeUndefined(); expect(t1).toBeLessThan(400);
  expect(timed(() => readTailSoft(p, 512 * 1024))[1]).toBeLessThan(50);     // en cours : toujours rien, sans attendre
  await sleep(1000);
  expect(readTailSoft(p, 512 * 1024)).toEqual({ size: 55, lines: ['{"timestamp":"2026-01-02T03:04:05.000Z","a":1}', '{"b":2}'] });
  expect(transcriptCreatedAt(p)).toBeNull();                                // pas de réponse à temps : redemandé plus tard
  await sleep(1000);
  expect(transcriptCreatedAt(p)).toBe(Date.parse('2026-01-02T03:04:05.000Z'));
});

test('tous les fils occupés : un fichier jamais lu est lu directement, un fichier déjà lu rend sa valeur', async () => {
  put(f('connu.json'), '{"k":1}', 1_700_000_000_000);
  expect(readJson(f('connu.json'))).toEqual({ k: 1 });
  for (const n of ['lent-1.jsonl', 'lent-2.jsonl']) { writeFileSync(f(n), 'x\n'); expect(readTailSoft(f(n), 1 << 20)).toBeUndefined(); }
  put(f('connu.json'), '{"k":2}', 1_700_000_001_000);
  put(f('neuf.json'), '{"n":1}', 1_700_000_000_000);
  expect(readJson(f('neuf.json'))).toEqual({ n: 1 });
  expect(readJson(f('connu.json'))).toEqual({ k: 1 });
  expect(mtimeMs(f('connu.json'))).toBe(1_700_000_000_000);
  await sleep(1100);
  expect(readJson(f('connu.json'))).toEqual({ k: 2 });
});

test('tâches programmées : lecture incrémentale par la garde, ligne incomplète lue plus tard, fichier réécrit repris du début', () => {
  const p = f('sched.jsonl');
  const line = (id: string): string => JSON.stringify({ type: 'system', subtype: 'scheduled_task_fire', taskId: id, pad: 'x'.repeat(30) }) + '\n';
  writeFileSync(p, line('a') + '{"type":"user"}\n');
  const sc = new ScheduleScan();
  const n1 = sc.lines(p).length;
  expect(n1).toBe(1);
  appendFileSync(p, line('b') + line('c').slice(0, 20));                    // dernière ligne incomplète : lue plus tard
  expect(sc.lines(p, fileSize(p))).toHaveLength(2);
  appendFileSync(p, line('c').slice(20));
  expect(sc.lines(p, fileSize(p))).toHaveLength(3);
  rmSync(p);
  expect(sc.lines(p)).toHaveLength(3);                                      // absent : les lignes connues
  writeFileSync(p, line('z'));                                              // réécrit plus court : repris du début
  expect(sc.lines(p)).toHaveLength(1);
});
