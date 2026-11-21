// Schéma du fichier de configuration (config.schema.json) et son vérificateur (schema.ts).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as group, expect, it } from 'vitest';
import { configSchema, describe, unknownKeywords, validate } from '../src/schema.ts';
import { configWarnings, loadSettings } from '../src/modules.ts';

const json = (rel: string): unknown => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const lines = (v: unknown): string[] => describe(validate(v));
const env = { home: 'C:\\Users\\alex', localAppData: 'C:\\Users\\alex\\AppData\\Local', temp: 'C:\\Temp' };

group('config.schema.json', () => {
  it('ne contient que des mots-clés que le vérificateur comprend', () => {
    expect(unknownKeywords(configSchema())).toEqual([]);
  });
  it('accepte l’exemple publié et la config des tests de l’étiqueteur', () => {
    expect(lines(json('../config.example.json'))).toEqual([]);
    expect(lines(json('./fixtures/tagger-config.json'))).toEqual([]);
  });
  it('l’exemple pointe vers le schéma servi par le serveur du poste', () => {
    expect((json('../config.example.json') as Record<string, unknown>).$schema).toBe('http://localhost:8765/config.schema.json');
  });
  it('accepte une config vide', () => { expect(lines({})).toEqual([]); });
});

group('validate', () => {
  it('nomme une clé mal orthographiée, à sa place', () => {
    expect(lines({ modules: { teams: { enabled: true, remindrs: true } } })).toEqual(['modules.teams.remindrs : clé inconnue, ignorée']);
    expect(lines({ uii: {} })).toEqual(['uii : clé inconnue, ignorée']);
  });
  it('dit le type attendu', () => {
    expect(lines({ modules: { teams: { enabled: 'yes' } } })).toEqual(['modules.teams.enabled : attendu : true ou false, trouvé : un texte']);
    expect(lines({ ui: { quota: { warn: 75.5 } } })).toEqual(['ui.quota.warn : attendu : un entier, trouvé : un nombre']);
    expect(lines({ ui: { models: {} } })).toEqual(['ui.models : attendu : une liste [ … ], trouvé : un objet { … }']);
  });
  it('vérifie bornes, longueurs, listes et valeurs admises', () => {
    expect(lines({ ui: { quota: { alert: 120 } } })).toEqual(['ui.quota.alert : 100 au plus (120)']);
    expect(lines({ ui: { models: [{ match: 'opus', cost: 0 }] } })).toEqual(['ui.models[0].cost : plus de 0 (0)']);
    expect(lines({ ui: { language: 'de' } })).toEqual(['ui.language : valeur refusée "de" (admis : "", "en", "fr")']);
    expect(lines({ ui: { shortcuts: Array.from({ length: 9 }, () => ({ label: 'x', command: '/compact' })) } })).toEqual(['ui.shortcuts : 8 éléments au plus (9)']);
    expect(lines({ claudeArgs: '--model opus; calc' })[0]).toMatch(/^claudeArgs : forme refusée/);
  });
  it('signale une clé obligatoire absente et une expression régulière invalide', () => {
    expect(lines({ modules: { launcher: { cli: 'C:\\x.py' } } })).toEqual(['modules.launcher : clé « root » obligatoire']);
    expect(lines({ tagger: { worktrees: ['(' ] } })[0]).toMatch(/^tagger\.worktrees\[0\] : expression régulière invalide/);
  });
  it('suit les références ($defs)', () => {
    expect(lines({ tagger: { tools: [{ v: 'x' }] } })).toEqual(['tagger.tools[0] : clé « re » obligatoire']);
    expect(lines({ newSession: { folders: [3] } })).toEqual(['newSession.folders[0] : attendu : un texte, trouvé : un entier']);
  });
});

group('loadSettings', () => {
  it('rend les écarts au schéma sans rien éteindre de ce qui est juste', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sd-schema-'));
    const f = join(dir, 'config.json');
    writeFileSync(f, JSON.stringify({ modules: { teams: { enabled: true, remindrs: true } }, ui: { quota: { warn: 60, alert: 80 } } }));
    const s = loadSettings(f, env);
    expect(s.error).toBeNull();
    expect(s.modules.teams).toBe(true);
    expect(s.ui.quota).toEqual({ warn: 60, alert: 80 });
    expect(s.warnings).toEqual(['modules.teams.remindrs : clé inconnue, ignorée']);
  });
  it('plafonne la liste à 20 lignes', () => {
    const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, 1]));
    const w = configWarnings(many);
    expect(w).toHaveLength(21);
    expect(w[20]).toBe('… et 5 autres');
  });
  it('fichier absent ou illisible : aucun écart (l’erreur suffit)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sd-schema-'));
    expect(loadSettings(join(dir, 'absent.json'), env).warnings).toEqual([]);
    const f = join(dir, 'config.json'); writeFileSync(f, '{ "ui": ');
    const s = loadSettings(f, env);
    expect(s.error).not.toBeNull();
    expect(s.warnings).toEqual([]);
  });
});
