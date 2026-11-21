// Édition de config.json depuis la page : contrôles (config-edit.ts) et compte rendu affiché (cfgLines, app.js).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { changedPaths, checkConfig, KEEP_BACKUPS, openConfig, protectedChanges, saveConfig, textHash } from '../src/config-edit.ts';
import { PAGE_DIR } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'sd-cfgedit-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = (content: string | null): string => {
  const dir = join(root, `p${++n}`); mkdirSync(dir);
  const f = join(dir, 'config.json'); if (content !== null) writeFileSync(f, content); return f;
};
const J = (v: unknown): string => JSON.stringify(v, null, 2);

describe('clés protégées', () => {
  test('ajoutée, retirée ou changée : refusée ; identique : admise', () => {
    const before = { claudeArgs: '--model opus', modules: { teams: { enabled: true, inbound: { cwd: 'C:\\a', domains: ['example.com'] } } } };
    expect(protectedChanges(before, before)).toEqual([]);
    expect(protectedChanges(before, { ...before, claudeArgs: '--model opus --dangerously-skip-permissions' })).toEqual(['claudeArgs']);
    expect(protectedChanges(before, { modules: before.modules })).toEqual(['claudeArgs']);
    expect(protectedChanges(before, { ...before, tailscaleExe: 'C:\\evil.exe' })).toEqual(['tailscaleExe']);
    expect(protectedChanges(before, { ...before, modules: { teams: { enabled: true, inbound: { cwd: 'C:\\a', domains: ['example.com', 'other.example'] } } } })).toEqual(['modules.teams.inbound.domains']);
    expect(protectedChanges({}, { modules: { automations: [] } })).toEqual(['modules.automations']);
    expect(protectedChanges({}, { modules: { teams: { export: { command: ['calc'], ticketPattern: 'A-(\\d+)' } } } })).toEqual(['modules.teams.export']);
  });
  test('ce qui n’exécute rien reste modifiable : affichage, Teams sans commande, étiqueteur, délais', () => {
    const before = { modules: { teams: { enabled: false, reminders: false, inbound: { enabled: false, cwd: 'C:\\a' } } } };
    const after = { ui: { quota: { warn: 50, alert: 80 } }, delays: { closedDays: 3 }, tagger: { domains: ['Billing'] },
      modules: { teams: { enabled: true, reminders: true, inbound: { enabled: true, cwd: 'C:\\a' } }, tickets: { pattern: 'ABC-\\d{4}' } } };
    expect(protectedChanges(before, after)).toEqual([]);
  });
});

describe('changedPaths', () => {
  test('au niveau le plus fin qui reste un objet ; une liste en entier', () => {
    expect(changedPaths({ ui: { quota: { warn: 75, alert: 90 }, language: 'fr' } }, { ui: { quota: { warn: 60, alert: 90 }, language: 'fr' }, delays: { closedDays: 3 } }))
      .toEqual(['ui.quota.warn', 'delays']);
    expect(changedPaths({ tagger: { domains: ['A'] } }, { tagger: { domains: ['A', 'B'] } })).toEqual(['tagger.domains']);
    expect(changedPaths({ a: 1 }, { a: 1 })).toEqual([]);
  });
});

describe('checkConfig', () => {
  test('JSON illisible, ou autre chose qu’un objet', () => {
    expect(checkConfig('{}', '{ "ui": ').error).toMatch(/JSON|Unexpected|position/i);
    expect(checkConfig('{}', '[]')).toMatchObject({ ok: false, error: 'un objet { … } est attendu' });
  });
  test('écarts au schéma : non enregistrable, chacun à sa place', () => {
    const c = checkConfig('{}', J({ ui: { qouta: {} } }));
    expect(c).toMatchObject({ ok: false, error: null, problems: ['ui.qouta : clé inconnue, ignorée'], changed: ['ui'] });
  });
  test('fichier actuel illisible : une clé protégée présente compte comme ajoutée', () => {
    expect(checkConfig('{ oops', J({ claudeArgs: '' })).protectedChanged).toEqual(['claudeArgs']);
    expect(checkConfig('{ oops', J({ ui: { ticketLabel: 'T' } })).ok).toBe(true);
  });
});

describe('saveConfig', () => {
  test('enregistre le texte tel que tapé, garde la version précédente', () => {
    const cur = J({ claudeArgs: '--model opus', ui: { ticketLabel: 'A' } });
    const f = fresh(cur);
    const next = '{\n  "claudeArgs": "--model opus",\n  "ui": { "ticketLabel": "B" }   \n}';
    const r = saveConfig(f, textHash(cur), next, new Date('2026-11-21T10:20:30Z'));
    expect(r).toMatchObject({ ok: true, saved: true, conflict: false, changed: ['ui.ticketLabel'] });
    expect(readFileSync(f, 'utf8')).toBe(next + '\n');
    expect(r.backup).toBe(`${f}.bak-page-20261121-102030`);
    expect(readFileSync(r.backup!, 'utf8')).toBe(cur);
  });
  test('fichier changé depuis l’ouverture : 409, rien d’écrit', () => {
    const f = fresh(J({ ui: { ticketLabel: 'A' } }));
    const base = openConfig(f).base;
    writeFileSync(f, J({ ui: { ticketLabel: 'changé à la main' } }));
    const r = saveConfig(f, base, J({ ui: { ticketLabel: 'B' } }));
    expect(r).toMatchObject({ saved: false, conflict: true });
    expect(JSON.parse(readFileSync(f, 'utf8')).ui.ticketLabel).toBe('changé à la main');
  });
  test('clé protégée touchée ou schéma non respecté : refusé, rien d’écrit ni sauvegardé', () => {
    const cur = J({ claudeArgs: '' }); const f = fresh(cur);
    expect(saveConfig(f, textHash(cur), J({ claudeArgs: '--dangerously-skip-permissions' }))).toMatchObject({ saved: false, protectedChanged: ['claudeArgs'] });
    expect(saveConfig(f, textHash(cur), J({ claudeArgs: '', ui: { language: 'de' } }))).toMatchObject({ saved: false });
    expect(readFileSync(f, 'utf8')).toBe(cur);
    expect(readdirSync(join(f, '..')).filter((x) => x.includes('.bak-page-'))).toEqual([]);
  });
  test('fichier absent : créé, sans sauvegarde', () => {
    const f = fresh(null);
    const o = openConfig(f);
    expect(o.exists).toBe(false);
    const r = saveConfig(f, o.base, J({ ui: { ticketLabel: 'T' } }));
    expect(r).toMatchObject({ saved: true, backup: null });
    expect(existsSync(f)).toBe(true);
  });
  test(`garde les ${KEEP_BACKUPS} sauvegardes les plus récentes`, () => {
    let cur = J({ ui: { ticketLabel: 'v0' } }); const f = fresh(cur);
    for (let i = 1; i <= KEEP_BACKUPS + 3; i++) {
      const next = J({ ui: { ticketLabel: `v${i}` } });
      expect(saveConfig(f, textHash(cur), next, new Date(Date.UTC(2026, 10, 21, 10, 0, i))).saved).toBe(true);
      cur = next + '\n';
    }
    const baks = readdirSync(join(f, '..')).filter((x) => x.includes('.bak-page-')).sort();
    expect(baks).toHaveLength(KEEP_BACKUPS);
    expect(baks[0]).toBe('config.json.bak-page-20261121-100004');
  });
});

describe('page : compte rendu (cfgLines)', () => {
  const js = readFileSync(join(PAGE_DIR, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  const m = /\nfunction cfgLines\(r, kind\) \{[\s\S]*?\n\}\n/.exec(js);
  if (!m) throw new Error('cfgLines introuvable dans la page');
  const cfgLines = new Function(`${m[0]}; return cfgLines;`)() as (r: unknown, kind: string) => [string, string][];
  test('refus : clés protégées, puis écarts, puis ce qui a changé', () => {
    expect(cfgLines({ ok: false, error: null, problems: ['ui.qouta : clé inconnue, ignorée'], protectedChanged: ['claudeArgs'], changed: ['claudeArgs', 'ui'] }, 'save')).toEqual([
      ['bad', 'Clés protégées modifiées (à changer dans le fichier) : claudeArgs'],
      ['bad', 'ui.qouta : clé inconnue, ignorée'],
      ['', 'Modifié : claudeArgs, ui'],
    ]);
  });
  test('enregistré : la sauvegarde, puis appliqué ou à redémarrer', () => {
    expect(cfgLines({ ok: true, saved: true, backup: 'C:\\x.bak', restart: [], changed: ['ui.ticketLabel'], problems: [], protectedChanged: [] }, 'save')).toEqual([
      ['ok', 'Enregistré — version précédente : C:\\x.bak.'], ['ok', 'Appliqué tout de suite.'], ['', 'Modifié : ui.ticketLabel'],
    ]);
    expect(cfgLines({ ok: true, saved: true, backup: null, restart: ['modules.teams'], changed: ['modules.teams.enabled'], problems: [], protectedChanged: [] }, 'save')[1])
      .toEqual(['warn', 'Au prochain démarrage du serveur : modules.teams']);
  });
  test('conflit et JSON illisible', () => {
    expect(cfgLines({ conflict: true, ok: false, error: null, problems: [], protectedChanged: [], changed: ['ui'] }, 'save')).toHaveLength(1);
    expect(cfgLines({ ok: false, error: 'Unexpected end of JSON input' }, 'check')).toEqual([['bad', 'JSON illisible : Unexpected end of JSON input']]);
    expect(cfgLines(null, 'check')[0]![0]).toBe('bad');
  });
});
