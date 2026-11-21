// Version en service (version.ts) : lue dans DEPLOYED.txt d'une copie déployée, calculée avec git dans un checkout.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { parseDeployed, versionOf, versionReader } from '../src/version.ts';
import { REPO } from './helpers.ts';

const SHA = 'a'.repeat(40), SHA2 = 'b'.repeat(40);
const root = mkdtempSync(join(tmpdir(), 'sd-version-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('DEPLOYED.txt', () => {
  test('version et commit lus, où que soit la ligne « version »', () => {
    expect(parseDeployed(`commit ${SHA} (origin/main)\nversion 0.1.72\nposé le 2026-01-01T00:00:00 depuis C:\\x\nmode PRIMARY\n`)).toEqual({ version: '0.1.72', commit: SHA });
    expect(parseDeployed(`\uFEFFcommit ${SHA}\r\nposé le …\r\nversion 0.1.72+abc1234\r\n`)).toEqual({ version: '0.1.72+abc1234', commit: SHA });
  });
  test('copie posée avant la version : commit seul ; fichier illisible : null', () => {
    expect(parseDeployed(`commit ${SHA} (origin/main)\nposé le …\n`)).toEqual({ version: null, commit: SHA });
    expect(parseDeployed('commit abc\n')).toBeNull();
    expect(parseDeployed('')).toBeNull();
  });
});

test('majeur.mineur de package.json + rang du commit', () => {
  expect(versionOf('0.1.0', 72)).toBe('0.1.72');
  expect(versionOf('2.5.9-beta', 3)).toBe('2.5.3');
  expect(versionOf(null, 3)).toBe('0.0.3');
});

describe('lecteur', () => {
  test('copie déployée : relit DEPLOYED.txt quand il change (page remplacée à chaud)', () => {
    const f = join(root, 'DEPLOYED.txt');
    writeFileSync(f, `commit ${SHA}\nversion 0.1.72\n`);
    const read = versionReader(root);
    expect(read()).toEqual({ version: '0.1.72', commit: SHA });
    writeFileSync(f, `commit ${SHA2}\nversion 0.1.73\npage remplacée à chaud\n`);
    expect(read()).toEqual({ version: '0.1.73', commit: SHA2 });
  });
  test('checkout de développement : calculée avec git, suffixe -dev', () => {
    const v = versionReader(REPO)();
    expect(v?.version).toMatch(/^\d+\.\d+\.\d+-dev$/);
    expect(v?.commit).toMatch(/^[0-9a-f]{40}$/);
  });
  test('ni DEPLOYED.txt ni dépôt git : null', () => {
    const dir = mkdtempSync(join(root, 'vide-'));
    expect(versionReader(dir)()).toBeNull();
  });
});
