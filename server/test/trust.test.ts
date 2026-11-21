// Approbation des dossiers par Claude Code (trust.ts) : lue dans `.claude.json`, sur le dossier EXACT, et le lancement
// d'une nouvelle session refusé dans un dossier non approuvé — sauf branche neuve (worktree jamais approuvé d'avance).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { Actions } from '../src/actions.ts';
import { withDeclaredFolders } from '../src/state.ts';
import { claudeJsonPath, isTrusted, TrustReader, trustedRoots, trustKey } from '../src/trust.ts';

const dir = mkdtempSync(join(tmpdir(), 'sd-trust-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('lecture de .claude.json', () => {
  test('forme de comparaison : barres obliques, sans barre finale, minuscules', () => {
    expect(trustKey('C:\\Code\\Depot\\')).toBe('c:/code/depot');
    expect(trustKey('C:/Code/Depot')).toBe('c:/code/depot');
    expect(trustKey('C:\\')).toBe('c:');
  });
  test('seuls les projets marqués hasTrustDialogAccepted: true comptent, sous les deux formes de clé', () => {
    const raw = { projects: {
      'C:\\code\\a': { hasTrustDialogAccepted: true },
      'C:/code/b': { hasTrustDialogAccepted: true },
      'C:\\code\\c': { hasTrustDialogAccepted: false },
      'C:\\code\\d': {},
      'C:\\code\\e': { hasTrustDialogAccepted: 'true' },
      'C:\\code\\f': null,
    } };
    expect(trustedRoots(raw).sort()).toEqual(['c:/code/a', 'c:/code/b']);
  });
  test('fichier sans projets ou mal formé : aucun dossier approuvé', () => {
    for (const raw of [undefined, null, 3, [], {}, { projects: null }, { projects: [] }, { projects: 'x' }]) expect(trustedRoots(raw)).toEqual([]);
  });
});

describe('dossier approuvé : chemin EXACT, sans héritage', () => {
  const roots = trustedRoots({ projects: {
    'C:\\code': { hasTrustDialogAccepted: true },
    'C:/code/depot/backend': { hasTrustDialogAccepted: true },
    'C:\\code\\.claude\\worktrees\\essai': { hasTrustDialogAccepted: true },
  } });
  test('le dossier lui-même, quelle que soit la forme ou la casse', () => {
    expect(isTrusted('C:\\code', roots)).toBe(true);
    expect(isTrusted('c:/CODE/', roots)).toBe(true);
    expect(isTrusted('C:\\Code\\Depot\\Backend', roots)).toBe(true);
  });
  test('un parent approuvé ne couvre pas un sous-dossier (Claude Code pose la question)', () => {
    expect(isTrusted('C:\\code\\outil', roots)).toBe(false);
    expect(isTrusted('C:\\code\\depot', roots)).toBe(false);
    expect(isTrusted('C:\\code\\depot\\backend\\Api', roots)).toBe(false);
  });
  test('worktree : chacun s’approuve pour lui-même — un worktree neuf ne l’est jamais d’avance', () => {
    expect(isTrusted('C:\\code\\.claude\\worktrees\\essai', roots)).toBe(true);
    expect(isTrusted('C:\\code\\.claude\\worktrees\\neuf', roots)).toBe(false);
    expect(isTrusted('C:\\code\\.claude\\worktrees\\essai\\depot\\backend', roots)).toBe(false);
  });
  test('préfixe de nom sans séparateur : jamais confondu', () => {
    expect(isTrusted('C:\\codex', roots)).toBe(false);
  });
  test('chemin vide : non approuvé', () => { expect(isTrusted('', roots)).toBe(false); });
});

describe('emplacement et relecture du fichier', () => {
  test('.claude.json dans le dossier de configuration s’il y est, sinon à côté', () => {
    expect(claudeJsonPath('C:\\Users\\moi\\.claude', () => false)).toBe(join('C:\\Users\\moi', '.claude.json'));
    expect(claudeJsonPath('C:\\cfg', (f) => f === join('C:\\cfg', '.claude.json'))).toBe(join('C:\\cfg', '.claude.json'));
  });
  test('absent : statut inconnu (null), jamais « non approuvé »', () => {
    expect(new TrustReader(() => join(dir, 'absent.json')).trusted('C:\\code')).toBeNull();
  });
  test('relu quand il change ; une écriture en cours (JSON incomplet) garde le dernier état lu', () => {
    const f = join(dir, 'claude.json'); const r = new TrustReader(() => f);
    writeFileSync(f, JSON.stringify({ projects: { 'C:\\code': { hasTrustDialogAccepted: true } } }));
    expect(r.trusted('C:\\code')).toBe(true);
    expect(r.trusted('C:\\autre')).toBe(false);
    writeFileSync(f, '{ "projects": { "C:\\\\autre": { "hasTrust');
    expect(r.trusted('C:\\code')).toBe(true);
    writeFileSync(f, JSON.stringify({ projects: { 'C:\\autre': { hasTrustDialogAccepted: true }, padding: 'xxxxxxxx' } }));
    expect(r.trusted('C:\\autre')).toBe(true);
    expect(r.trusted('C:\\code')).toBe(false);
  });
  test('jamais lisible : inconnu', () => {
    const f = join(dir, 'casse.json'); writeFileSync(f, '{');
    expect(new TrustReader(() => f).trusted('C:\\code')).toBeNull();
  });
});

describe('garde du lancement « Nouvelle session »', () => {
  mkdirSync(join(dir, 'state'));
  const ok = join(dir, 'approuve'); mkdirSync(ok);
  const ko = join(dir, 'non-approuve'); mkdirSync(ko);
  const repo = join(dir, 'depot'); mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const status = new Map<string, boolean | null>([[ok, true], [ko, false], [repo, false]]);
  const make = (): { a: Actions; calls: [string, unknown][] } => {
    const calls: [string, unknown][] = [];
    const d = {
      cfg: { claudeArgs: '' }, sessionsDir: join(dir, 'sessions'), openSeen: new Map(),
      openSessions: async () => [], meta: () => ({}),
      newFolders: async () => withDeclaredFolders([], [ok, ko, repo, join(dir, 'inconnu')], () => true),
      trusted: (p: string) => status.get(p) ?? null,
      sf: (n: string) => join(dir, 'state', n), setTag: () => null, setSeen: () => undefined, tagVocab: () => ({}),
      driver: { call: async (op: string, args: unknown) => { calls.push([op, args]); return 0; } },
    };
    return { a: new Actions(d as never), calls };
  };
  test('dossier approuvé : la session se lance', async () => {
    const { a, calls } = make();
    expect(await a.newSession(ok, '', '', '')).toBeNull();
    expect(calls).toHaveLength(1);
  });
  test('dossier non approuvé : refusé, avec la marche à suivre, sans ouvrir d’onglet', async () => {
    const { a, calls } = make();
    const err = await a.newSession(ko, 'bonjour', '', '');
    expect(err).toContain('dossier non approuvé dans Claude Code');
    expect(err).toContain(ko);
    expect(err).toContain('Lancez une fois `claude` dans ce dossier');
    expect(calls).toEqual([]);
  });
  test('statut inconnu (configuration illisible) : on lance quand même', async () => {
    const { a, calls } = make();
    expect(await a.newSession(join(dir, 'inconnu'), '', '', '')).toBeNull();
    expect(calls).toHaveLength(1);
  });
  test('branche neuve depuis un dossier non approuvé : pas de refus (le worktree neuf posera la question, la page prévient)', async () => {
    const { a, calls } = make();
    expect(await a.newSession(repo, '', '', 'feat/essai-approbation')).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
