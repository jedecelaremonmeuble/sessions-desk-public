// Dossiers déclarés du formulaire « Nouvelle session » (newSession.folders de config.json) : lus, fusionnés aux
// dossiers récents, et acceptés par le serveur au même titre qu'eux — et seulement eux.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { Actions } from '../src/actions.ts';
import { parseArgs } from '../src/config.ts';
import { loadSettings, parseNewSessionFolders } from '../src/modules.ts';
import { withDeclaredFolders } from '../src/state.ts';

const env = { home: 'C:\\Users\\moi', localAppData: 'C:\\Users\\moi\\AppData\\Local', temp: 'C:\\Temp' };
const dir = mkdtempSync(join(tmpdir(), 'sd-new-folders-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('lecture de newSession.folders', () => {
  test('absente ou mal décrite : aucun dossier déclaré', () => {
    for (const raw of [null, {}, { newSession: null }, { newSession: { folders: 'C:\\code' } }, { newSession: [] }]) expect(parseNewSessionFolders(raw, env)).toEqual([]);
    expect(loadSettings(join(dir, 'absent.json'), env).newFolders).toEqual([]);
  });
  test('chemins absolus développés, sans barre finale ni doublon ; les entrées invalides sont ignorées', () => {
    expect(parseNewSessionFolders({ newSession: { folders: ['C:\\code\\depot\\', '~\\outils', '%LOCALAPPDATA%\\x', 'c:\\CODE\\depot', 'relatif', '', 3, null, 'C:\\a;b', 'C:\\'] } }, env))
      .toEqual(['C:\\code\\depot', 'C:\\Users\\moi\\outils', 'C:\\Users\\moi\\AppData\\Local\\x', 'C:\\']);
  });
  test('50 dossiers au plus', () => {
    const many = Array.from({ length: 60 }, (_, i) => `C:\\d${i}`);
    expect(parseNewSessionFolders({ newSession: { folders: many } }, env)).toHaveLength(50);
  });
  test('config.json → Config.newFolders', () => {
    const f = join(dir, 'cfg.json'); writeFileSync(f, JSON.stringify({ newSession: { folders: ['C:\\code\\depot'] } }));
    expect(parseArgs(['--config', f], { USERPROFILE: dir, LOCALAPPDATA: join(dir, 'lad'), TEMP: dir }).newFolders).toEqual(['C:\\code\\depot']);
  });
});

describe('fusion avec les dossiers récents', () => {
  const all = (): boolean => true;
  test('un déclaré sans session récente vient après les récents, sans date ni compte', () => {
    expect(withDeclaredFolders([{ path: 'C:\\a', last: 1, count: 2 }, { path: 'C:\\b', last: 5, count: 1 }], ['C:\\neuf'], all)).toEqual([
      { path: 'C:\\b', last: 5, count: 1 }, { path: 'C:\\a', last: 1, count: 2 }, { path: 'C:\\neuf', last: 0, count: 0, declared: true }]);
  });
  test('un déclaré déjà récent garde sa place et sa date (casse ignorée), sans doublon', () => {
    expect(withDeclaredFolders([{ path: 'C:\\Code', last: 3, count: 4 }], ['c:\\code'], all)).toEqual([{ path: 'C:\\Code', last: 3, count: 4, declared: true }]);
  });
  test('un dossier qui n’existe plus n’est jamais proposé, déclaré ou non', () => {
    const exists = (p: string): boolean => p !== 'C:\\parti' && p !== 'C:\\disparu';
    expect(withDeclaredFolders([{ path: 'C:\\parti', last: 1, count: 1 }], ['C:\\disparu', 'C:\\la'], exists)).toEqual([{ path: 'C:\\la', last: 0, count: 0, declared: true }]);
  });
});

describe('garde du lancement', () => {
  mkdirSync(join(dir, 'state'));
  const declared = join(dir, 'declare'); mkdirSync(declared);
  const make = (folders: { path: string; last: number; count: number }[]): { a: Actions; calls: [string, unknown][] } => {
    const calls: [string, unknown][] = [];
    const d = {
      cfg: { claudeArgs: '' }, sessionsDir: join(dir, 'sessions'), openSeen: new Map(),
      openSessions: async () => [], meta: () => ({}), newFolders: async () => folders,
      sf: (n: string) => join(dir, 'state', n), setTag: () => null, setSeen: () => undefined, tagVocab: () => ({}),
      driver: { call: async (op: string, args: unknown) => { calls.push([op, args]); return 0; } },
    };
    return { a: new Actions(d as never), calls };
  };
  test('dossier déclaré : la session se lance dedans', async () => {
    const { a, calls } = make(withDeclaredFolders([], [declared], () => true));
    expect(await a.newSession(declared, '', '', '')).toBeNull();
    expect(calls).toEqual([['wt', { args: expect.stringContaining(`nt -d "${declared}" `) }]]);
  });
  test('dossier ni récent ni déclaré : toujours refusé', async () => {
    const { a, calls } = make(withDeclaredFolders([], [declared], () => true));
    expect(await a.newSession(join(dir, 'ailleurs'), '', '', '')).toBe('dossier non proposé');
    expect(calls).toEqual([]);
  });
});
