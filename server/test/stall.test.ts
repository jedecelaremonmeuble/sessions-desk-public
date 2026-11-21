// Trace de performance (stall.ts) : verdict calcul / attente, ligne de démarrage, et le guetteur réel (fil de
// travail) devant un fil principal BLOQUÉ — par du calcul (CPU ≈ durée) puis par une attente (Atomics.wait, CPU ≈ 0).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import { opTarget, setPhase, startStallWatch, startupLine, stallVerdict, tracked } from '../src/stall.ts';
import { sleep } from './parity/harness.ts';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const dir = mkdtempSync(join(tmpdir(), 'sd-stall-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
const read = (f: string): string => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const busy = (ms: number): void => { const end = Date.now() + ms; while (Date.now() < end) { /* calcul */ } };
const asleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const until = async (f: () => boolean, ms = 3000): Promise<void> => { for (let i = 0; i < ms / 50 && !f(); i++) await sleep(50); };

test('verdict : CPU ≈ durée => calcul ; CPU ≈ 0 => attente ; entre les deux => mêlés', () => {
  expect(stallVerdict(10000, 9500)).toMatch(/calculait/);
  expect(stallVerdict(10000, 300)).toMatch(/attendait/);
  expect(stallVerdict(10000, 4000)).toMatch(/mêlés/);
  expect(stallVerdict(0, 0)).toMatch(/attendait/);
});

test('ligne de démarrage : chaque phase, le total, le CPU ; « LENT » au-delà du seuil', () => {
  const l = startupLine([['modules', 812.4], ['écoute', 15]], 1600, 1300);
  expect(l).toBe('démarrage : modules 812 ms · écoute 15 ms · total 1600 ms (CPU 1300 ms, le serveur calculait (code))');
  expect(startupLine([['1er état', 34000]], 35000, 900)).toMatch(/^démarrage LENT : .*attendait/);
});

test('gel par CALCUL puis gel par ATTENTE : vus du fil de travail, avec la phase et le bon verdict', async () => {
  const f = join(dir, 'a.perf.log');
  const w = startStallWatch(f, { thresholdMs: 500, everyMs: 100, beatMs: 50, repeatMs: 400 });
  try {
    await sleep(300);                         // le guetteur prend ses repères
    setPhase('état'); busy(1500);
    await until(() => /débloquée.*phase état/.test(read(f)));
    setPhase('index'); asleep(1500);
    await until(() => /débloquée.*phase index/.test(read(f)));
  } finally { await w.stop(); }
  const log = read(f);
  expect(log).toMatch(/boucle figée depuis \d+ ms \(phase état\)/);
  expect(log).toMatch(/boucle toujours figée depuis \d+ ms \(phase état\)/);   // un gel qui dure est re-signalé
  expect(log).toMatch(/débloquée après \d+ ms \(phase état\) : CPU \d+ ms sur \d+ ms, le serveur calculait/);
  expect(log).toMatch(/débloquée après \d+ ms \(phase index\) : CPU \d+ ms sur \d+ ms, le serveur attendait/);
  // La fenêtre de mesure du CPU couvre TOUT le gel : un repère pris pendant le gel la raccourcirait.
  for (const m of log.matchAll(/débloquée après (\d+) ms .* sur (\d+) ms/g)) expect(Number(m[2])).toBeGreaterThanOrEqual(Number(m[1]) * 0.9);
}, 20000);

test('gel dans un appel synchrone suivi : le gel désigne l\'appel et son fichier ; hors appel, il le dit', async () => {
  const f = join(dir, 'c.perf.log');
  const w = startStallWatch(f, { thresholdMs: 500, everyMs: 100, beatMs: 50, slowOpMs: 300 });
  const lire = tracked('readFileSync', (_p: string, ms: number): string => { asleep(ms); return 'lu'; });
  try {
    await sleep(300);
    setPhase('état'); expect(lire('C:\\données\\gros.jsonl', 1500)).toBe('lu');
    await until(() => /débloquée.*phase état/.test(read(f)));
    setPhase('index'); asleep(1500);
    await until(() => /débloquée.*phase index/.test(read(f)));
    lire('C:\\données\\petit.json', 5);        // rapide : aucune ligne
  } finally { await w.stop(); }
  const log = read(f);
  expect(log).toMatch(/boucle figée depuis \d+ ms \(phase état\) ; appel en cours depuis \d+ ms : readFileSync C:\\données\\gros\.jsonl/);
  expect(log).toMatch(/débloquée après \d+ ms \(phase état\) : .* ; au début du gel : appel en cours depuis \d+ ms : readFileSync C:\\données\\gros\.jsonl/);
  expect(log).toMatch(/appel lent : readFileSync C:\\données\\gros\.jsonl : \d{4} ms/);
  expect(log).toMatch(/boucle figée depuis \d+ ms \(phase index\) ; aucun appel synchrone suivi en cours/);
  expect(log).not.toMatch(/petit\.json/);
}, 20000);

test('cible d\'un appel : la fin d\'un chemin long, le fichier d\'un descripteur ouvert, le début d\'une commande', () => {
  expect(opTarget('C:\\a\\' + 'x'.repeat(300) + '\\fin.jsonl')).toMatch(/^….{90}\\fin\.jsonl$/);
  expect(opTarget(987654)).toBe('descripteur 987654');
  expect(opTarget(undefined)).toBe('');
  const ouvrir = tracked('openSync', (_p: string): number => 987654), fermer = tracked('closeSync', (_fd: number): void => undefined);
  ouvrir('C:\\a\\b.txt'); expect(opTarget(987654)).toBe('C:\\a\\b.txt');
  fermer(987654); expect(opTarget(987654)).toBe('descripteur 987654');
});

test('traceSyncOps : les imports nommés de node:fs et node:child_process des autres modules sont suivis', async () => {
  const f = join(dir, 'd.perf.log'); const cible = join(dir, 'cible.txt');
  const src = `import { readFileSync, writeFileSync } from 'node:fs'; import { execFileSync } from 'node:child_process';
    import { startStallWatch, traceSyncOps } from ${JSON.stringify(new URL('../src/stall.ts', import.meta.url).href)};
    const w = startStallWatch(${JSON.stringify(f)}, { slowOpMs: 0 }); traceSyncOps(); traceSyncOps();
    writeFileSync(${JSON.stringify(cible)}, 'x'); if (readFileSync(${JSON.stringify(cible)}, 'utf8') !== 'x') process.exit(3);
    execFileSync(process.execPath, ['-e', '0']); await w.stop();`;
  const code = await new Promise<number | null>((ok) => { spawn(process.execPath, ['--input-type=module', '-e', src], { windowsHide: true, stdio: 'ignore' }).on('exit', ok); });
  expect(code).toBe(0);
  const log = read(f);
  expect(log.split(cible).length - 1).toBe(2);          // une ligne par appel, pas deux (appel suivi une seule fois)
  expect(log).toContain(`appel lent : writeFileSync ${cible} : `);
  expect(log).toContain(`appel lent : readFileSync ${cible} : `);
  expect(log).toMatch(/appel lent : execFileSync .*node(\.exe)? -e 0 : \d+ ms/);
}, 30000);

test('boucle libre : aucune ligne', async () => {
  const f = join(dir, 'b.perf.log');
  const w = startStallWatch(f, { thresholdMs: 500, everyMs: 100, beatMs: 50 });
  await sleep(1200); await w.stop();
  expect(read(f)).toBe('');
});

test('serveur réel : une ligne de démarrage par lancement, phases jusqu\'au 1er état', async () => {
  // Port libre et profil vide À LUI : jamais le port fixe de la parité, qu'une autre suite peut tenir au même moment.
  const port = await new Promise<number>((ok) => { const t = createServer().listen(0, '127.0.0.1', () => { const a = t.address() as AddressInfo; t.close(() => ok(a.port)); }); });
  const home = join(dir, 'home'); const temp = join(dir, 'tmp');
  for (const d of [join(home, '.claude'), join(home, 'AppData', 'Local'), temp]) mkdirSync(d, { recursive: true });
  const f = join(temp, `sessions-desk-node-${port}.perf.log`);
  const proc = spawn(process.execPath, [join(REPO, 'server', 'src', 'main.ts'), '--port', String(port), '--no-background', '--tailscale', ''],
    { env: { ...process.env, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local'), TEMP: temp, TMP: temp }, windowsHide: true, stdio: 'ignore' });
  try {
    await until(() => read(f).includes('1er état'), 30000);
    expect(read(f)).toMatch(/démarrage( LENT)? : modules \d+ ms · préparation \d+ ms · protocole \d+ ms · identité \d+ ms · purge \d+ ms · écoute \d+ ms · 1er état \d+ ms · total \d+ ms \(CPU \d+ ms, /);
    expect(Number(/modules (\d+) ms/.exec(read(f))![1])).toBeGreaterThan(0);   // le chargement des modules compte, depuis le lancement
  } finally { proc.kill(); }
}, 60000);
