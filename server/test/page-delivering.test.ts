// Livraison demandée ou en cours (étape `delivering` de l'orchestrateur) : la page ne repropose plus « Livrer la PR » et
// dit où en est la livraison. Fonctions PURES d'app.js, extraites du fichier servi — la page n'est pas un module.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const js = readFileSync(fileURLToPath(new URL('../../page/app.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
function grab(name: string): string {
  const m = js.match(new RegExp('\\nfunction ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n')) ?? js.match(new RegExp('\\nfunction ' + name + '\\([^)]*\\) \\{.*\\}\\n'));
  if (!m) throw new Error(name + ' introuvable dans la page');
  return m[0];
}
type Wait = { stage: string; since?: number };
type Fns = { runOrders: (phase: string, stage: string | null, pr: unknown) => string[];
  deliveringNote: (stage: string | null, since: number | null, mergeAt: number | null, now: number) => string | null;
  deliveringWait: (it: { runs?: { wait?: Wait | null }[] }) => Wait | null };
const fns = new Function("const hhmm = t => 'HH:MM';" + ['runOrders', 'deliveringNote', 'deliveringWait'].map(grab).join('\n')
  + '\nreturn { runOrders, deliveringNote, deliveringWait };')() as Fns;

describe('étape delivering', () => {
  test('runOrders : plus aucun geste de livraison, quel que soit le run affiché', () => {
    for (const phase of ['dev', 'relecture', 'recette', 'reprise', 'merge']) expect(fns.runOrders(phase, 'delivering', 42)).toEqual([]);
    expect(fns.runOrders('diagnostic', 'delivering', 42)).toEqual(['verdict']);
    // Avant la demande de livraison, rien ne change.
    expect(fns.runOrders('relecture', 'pr-awaiting-approval', 42)).toEqual(['merge', 'review', 'recette-skip', 'rework']);
  });
  test('runOrders : pas de second feu vert sur un run go, sauf dev mort', () => {
    expect(fns.runOrders('go', null, null)).toEqual([]);
    expect(fns.runOrders('go', 'dev-failed', null)).toEqual(['go']);
    expect(fns.runOrders('go', 'dev-abandoned', null)).toEqual(['go']);
    expect(fns.runOrders('diagnostic', null, null)).toEqual(['go', 'verdict']);
  });
  test('goHeldFor : pas de go tant que le dernier run est celui de la carte répondue', () => {
    const goHeldFor = new Function(grab('goHeldFor') + '\nreturn goHeldFor;')() as (h: Map<string, string>, hd: unknown, d: string | null) => boolean;
    const held = new Map([['111111', 'run-diag']]);
    expect(goHeldFor(held, 111111, 'run-diag')).toBe(true);
    expect(goHeldFor(held, '111111', 'run-go')).toBe(false);
    expect(goHeldFor(held, '222222', 'run-diag')).toBe(false);
    expect(goHeldFor(held, '111111', null)).toBe(false);
  });
  test('deliveringNote : demandée, puis en cours depuis le début du run de livraison', () => {
    const t0 = 1_000_000_000_000;
    expect(fns.deliveringNote('pr-awaiting-approval', t0, null, t0)).toBeNull();
    expect(fns.deliveringNote('delivering', t0, null, t0 + 20_000)).toMatch(/^🚀 Livraison demandée à HH:MM — le lanceur la prend à sa prochaine passe\./);
    expect(fns.deliveringNote('delivering', t0, t0 + 40_000, t0 + 40_000 + 7 * 60_000)).toMatch(/^🚀 Livraison demandée à HH:MM — en cours depuis 7 min\./);
    expect(fns.deliveringNote('delivering', null, null, t0)).toMatch(/^🚀 Livraison le lanceur/);
  });
  test('deliveringWait : l’attente du dernier run, seulement si c’est une livraison', () => {
    const w = { stage: 'delivering', since: 1 };
    expect(fns.deliveringWait({ runs: [{ wait: null }, { wait: w }] })).toBe(w);
    expect(fns.deliveringWait({ runs: [{ wait: { stage: 'pr-awaiting-approval' } }] })).toBeNull();
    expect(fns.deliveringWait({})).toBeNull();
  });
});
