// Réouverture d'une session fermée : deux demandes rapprochées (suivi Teams avec deux attentes sur la même session,
// double clic) n'ouvrent qu'UN onglet. La session met quelques secondes à apparaître : le contrôle « déjà ouverte »
// seul laissait passer la seconde, et la conversation tournait dans deux process.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { Actions } from '../src/actions.ts';

const dir = mkdtempSync(join(tmpdir(), 'sd-rouvrir-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ID = 'aaaaaaaa-0000-4000-8000-000000000002', ID2 = 'aaaaaaaa-0000-4000-8000-000000000003';
const cwd = join(dir, 'projet'); mkdirSync(cwd); mkdirSync(join(dir, 'state'));

/** Tableau de bord réduit : `open` est la liste des sessions ouvertes, modifiable en cours de test. */
function make(): { a: Actions; tabs: () => number; open: Record<string, unknown>[] } {
  const calls: string[] = []; const open: Record<string, unknown>[] = [];
  const d = {
    cfg: { claudeArgs: '' }, sessionsDir: join(dir, 'sessions'), openSeen: new Map(),
    openSessions: async () => open, meta: () => ({ path: join(dir, 'x.jsonl'), cwd }),
    sf: (n: string) => join(dir, 'state', n),
    driver: { call: async (op: string, args: { args?: string }) => { if (op === 'wt') calls.push(args.args ?? ''); return 0; } },
  };
  return { a: new Actions(d as never), tabs: () => calls.reduce((n, c) => n + (c.match(/(^| )nt -d /g) ?? []).length, 0), open };
}

describe('rouvrir deux fois la même session', () => {
  test('la seconde demande, avant que la session apparaisse : refusée, un seul onglet', async () => {
    const { a, tabs } = make();
    expect(await a.reopen(ID)).toBeNull();
    expect(await a.reopen(ID)).toBe('réouverture déjà en cours');
    expect(await a.reopenMany([ID, ID2])).toMatchObject({ error: null, opened: 1, skipped: 1 });
    expect(tabs()).toBe(2);   // ID une fois, ID2 une fois
  });
  test('la même session deux fois dans une réouverture groupée : un seul onglet', async () => {
    const { a, tabs } = make();
    expect(await a.reopenMany([ID, ID])).toMatchObject({ opened: 1, skipped: 1 });
    expect(tabs()).toBe(1);
  });
  test('une fois apparue puis refermée, elle se rouvre aussitôt', async () => {
    const { a, tabs, open } = make();
    expect(await a.reopen(ID)).toBeNull();
    open.push({ pid: 1, sessionId: ID, status: 'idle' });
    expect(await a.reopen(ID)).toBe('session déjà ouverte');
    open.length = 0;
    expect(await a.reopen(ID)).toBeNull();
    expect(tabs()).toBe(2);
  });
  test('pas apparue au bout du délai : une nouvelle demande passe', async () => {
    const { a, tabs } = make();
    a.reopenGraceMs = 0;
    expect(await a.reopen(ID)).toBeNull();
    expect(await a.reopen(ID)).toBeNull();
    expect(tabs()).toBe(2);
  });
});
