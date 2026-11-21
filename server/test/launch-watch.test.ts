// « Lancée mais rien ne tourne » (launch-watch.ts) : un lancement de nouvelle session est rapproché de la session qui
// démarre ; sans elle au-delà d'une minute, il est signalé — jusqu'à ce qu'elle apparaisse ou qu'on l'écarte.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { Actions } from '../src/actions.ts';
import { isLate, KEEP_MS, LATE_MS, LaunchWatch, matchLaunches, probableCause, type Launch, type Observed } from '../src/launch-watch.ts';
import { withDeclaredFolders } from '../src/state.ts';

const dir = mkdtempSync(join(tmpdir(), 'sd-launch-watch-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const T0 = 1_800_000_000_000;
const L = (o: Partial<Launch>): Launch => ({ id: 'l1', at: T0, cwd: 'C:\\code\\depot', worktree: false, prompt: '', state: 'pending', ...o });
const O = (sessionId: string, cwd: string, startedAt: number): Observed => ({ sessionId, cwd, startedAt });

describe('rapprochement lancement ↔ session', () => {
  test('même dossier, casse et séparateurs ignorés, démarrée après le lancement', () => {
    const [l] = matchLaunches([L({})], [O('s1', 'c:/CODE/depot/', T0 + 3_000)]);
    expect(l).toMatchObject({ state: 'started', startedBy: 's1' });
  });
  test('autre dossier, ou sous-dossier : aucune correspondance', () => {
    expect(matchLaunches([L({})], [O('s1', 'C:\\code\\autre', T0 + 3_000), O('s2', 'C:\\code\\depot\\sous', T0 + 3_000)])[0]!.state).toBe('pending');
  });
  test('session démarrée AVANT le lancement (au-delà de la marge d’horloge) : ignorée', () => {
    expect(matchLaunches([L({})], [O('s1', 'C:\\code\\depot', T0 - 60_000)])[0]!.state).toBe('pending');
    expect(matchLaunches([L({})], [O('s1', 'C:\\code\\depot', T0 - 1_000)])[0]!.state).toBe('started');
  });
  test('identifiant fixé d’avance : seule CETTE session compte, quel que soit son dossier', () => {
    const l = L({ sid: 'AAAA-1' });
    expect(matchLaunches([l], [O('autre', 'C:\\code\\depot', T0 + 1_000)])[0]!.state).toBe('pending');
    expect(matchLaunches([l], [O('aaaa-1', 'C:\\ailleurs', T0 + 1_000)])[0]).toMatchObject({ state: 'started', startedBy: 'AAAA-1' });
  });
  test('identifiant fixé : un transcript déjà écrit suffit (session vite refermée)', () => {
    expect(matchLaunches([L({ sid: 'x' })], [], (sid) => sid === 'x')[0]!.state).toBe('started');
  });
  test('deux lancements dans le même dossier à quelques secondes : une session chacun, la plus ancienne au plus ancien', () => {
    const a = L({ id: 'a', at: T0 }), b = L({ id: 'b', at: T0 + 4_000 });
    const one = matchLaunches([b, a], [O('s1', 'C:\\code\\depot', T0 + 2_000)]);
    expect(one.find((l) => l.id === 'a')).toMatchObject({ state: 'started', startedBy: 's1' });
    expect(one.find((l) => l.id === 'b')!.state).toBe('pending');
    const two = matchLaunches(one, [O('s1', 'C:\\code\\depot', T0 + 2_000), O('s2', 'C:\\code\\depot', T0 + 6_000)]);
    expect(two.find((l) => l.id === 'b')).toMatchObject({ state: 'started', startedBy: 's2' });
  });
  test('une session déjà attribuée ne resert pas (relu après coup)', () => {
    const done = L({ id: 'a', state: 'started', startedBy: 's1' }), wait = L({ id: 'b', at: T0 + 1_000 });
    expect(matchLaunches([done, wait], [O('s1', 'C:\\code\\depot', T0 + 2_000)]).find((l) => l.id === 'b')!.state).toBe('pending');
  });
  test('écarté : n’est plus rapproché ni signalé', () => {
    const [l] = matchLaunches([L({ state: 'dismissed' })], [O('s1', 'C:\\code\\depot', T0 + 2_000)]);
    expect(l!.state).toBe('dismissed');
    expect(isLate(l!, T0 + 10 * LATE_MS)).toBe(false);
  });
  test('l’entrée n’est pas modifiée', () => {
    const src = [L({})]; matchLaunches(src, [O('s1', 'C:\\code\\depot', T0 + 1)]);
    expect(src[0]!.state).toBe('pending');
  });
});

describe('fenêtre et cause', () => {
  test('en retard seulement au-delà d’une minute', () => {
    expect(isLate(L({}), T0 + LATE_MS)).toBe(false);
    expect(isLate(L({}), T0 + LATE_MS + 1)).toBe(true);
    expect(isLate(L({ state: 'started' }), T0 + 10 * LATE_MS)).toBe(false);
  });
  test('dossier non approuvé ou worktree neuf : question d’approbation ; sinon, regarder l’onglet', () => {
    expect(probableCause(L({}), false).trust).toBe(true);
    expect(probableCause(L({ worktree: true }), null).trust).toBe(true);
    expect(probableCause(L({}), true)).toMatchObject({ trust: false });
    expect(probableCause(L({}), null).trust).toBe(false);
    expect(probableCause(L({}), false).text).toContain('répondez dans l’onglet');
  });
});

describe('fichier : redémarrage, notification, écart, purge', () => {
  test('un lancement survit au redémarrage du serveur et se rapproche ensuite', () => {
    const f = join(dir, 'restart.json'); let now = T0;
    const before = new LaunchWatch(f, () => now, () => 'id-1');
    before.record({ cwd: 'C:\\code\\depot', worktree: false, prompt: '  corrige   le bug\n du formulaire ' });
    now = T0 + 30_000;
    const after = new LaunchWatch(f, () => now);          // nouveau process : relit le fichier
    expect(after.list()).toEqual([{ id: 'id-1', at: T0, cwd: 'C:\\code\\depot', worktree: false, prompt: 'corrige le bug du formulaire', state: 'pending' }]);
    now = T0 + 90_000;
    expect(after.view(() => true).map((v) => v.id)).toEqual(['id-1']);
    after.update([O('s9', 'C:\\code\\depot', T0 + 70_000)]);   // démarrée pendant que le serveur était arrêté
    expect(after.view(() => true)).toEqual([]);
    expect(new LaunchWatch(f, () => now).list()[0]).toMatchObject({ state: 'started', startedBy: 's9' });
  });
  test('une notification par lancement, même après redémarrage', () => {
    const f = join(dir, 'alerts.json'); let now = T0;
    const w = new LaunchWatch(f, () => now, () => 'id-2');
    w.record({ cwd: 'C:\\x', worktree: true, prompt: '' });
    expect(w.takeAlerts()).toEqual([]);
    now = T0 + LATE_MS + 1;
    expect(w.takeAlerts().map((l) => l.id)).toEqual(['id-2']);
    expect(w.takeAlerts()).toEqual([]);
    expect(new LaunchWatch(f, () => now).takeAlerts()).toEqual([]);
  });
  test('écarter retire le signal ; un id inconnu ou déjà parti : faux', () => {
    const f = join(dir, 'dismiss.json'); let now = T0;
    const w = new LaunchWatch(f, () => now, () => 'id-3');
    w.record({ cwd: 'C:\\x', worktree: false, prompt: '' }); now = T0 + 2 * LATE_MS;
    expect(w.view(() => false)).toMatchObject([{ id: 'id-3', trust: true }]);
    expect(w.dismiss('inconnu')).toBe(false);
    expect(w.dismiss('id-3')).toBe(true);
    expect(w.dismiss('id-3')).toBe(false);
    expect(w.view(() => false)).toEqual([]);
  });
  test('oublié au-delà de 24 h', () => {
    const f = join(dir, 'purge.json'); let now = T0;
    const w = new LaunchWatch(f, () => now, () => 'id-4');
    w.record({ cwd: 'C:\\x', worktree: false, prompt: '' });
    now = T0 + KEEP_MS + 1; w.update([]);
    expect(w.list()).toEqual([]);
  });
  test('fichier abîmé : les entrées illisibles sont ignorées, pas fatales', () => {
    const f = join(dir, 'abime.json');
    writeFileSync(f, JSON.stringify([{ id: 'ok', at: T0, cwd: 'C:\\x' }, { id: 3 }, null, { id: 'sans-dossier', at: T0 }]));
    expect(new LaunchWatch(f, () => T0).list().map((l) => l.id)).toEqual(['ok']);
    writeFileSync(f, '{ pas du json');
    expect(new LaunchWatch(f, () => T0).list()).toEqual([]);
  });
});

describe('newSession note le lancement', () => {
  const ok = mkdtempSync(join(dir, 'ok-'));
  const make = (): { a: Actions; w: LaunchWatch } => {
    const w = new LaunchWatch(join(dir, `launches-${Math.random()}.json`));
    const d = {
      cfg: { claudeArgs: '' }, sessionsDir: join(dir, 'sessions'), openSeen: new Map(), openSessions: async () => [], meta: () => ({}),
      newFolders: async () => withDeclaredFolders([], [ok], () => true), trusted: () => true, launches: w,
      sf: (n: string) => join(dir, n), setTag: () => null, setSeen: () => undefined, tagVocab: () => ({}),
      driver: { call: async () => 0 },
    };
    return { a: new Actions(d as never), w };
  };
  test('onglet ouvert : lancement noté avec le dossier, le début du message, sans identifiant fixé', async () => {
    const { a, w } = make();
    expect(await a.newSession(ok, 'bonjour le monde', '', '')).toBeNull();
    expect(w.list()).toMatchObject([{ cwd: ok, worktree: false, prompt: 'bonjour le monde', state: 'pending' }]);
    expect(w.list()[0]!.sid).toBeUndefined();
  });
  test('identifiant fixé (veilleur, tags) : noté pour un rapprochement exact', async () => {
    const { a, w } = make();
    const sid = '11111111-2222-4333-8444-555555555555';
    expect(await a.newSession(ok, '', '', '', '', undefined, sid)).toBeNull();
    expect(w.list()[0]!.sid).toBe(sid);
  });
  test('lancement refusé : rien n’est noté', async () => {
    const { a, w } = make();
    expect(await a.newSession(join(dir, 'pas-propose'), '', '', '')).not.toBeNull();
    expect(w.list()).toEqual([]);
  });
});
