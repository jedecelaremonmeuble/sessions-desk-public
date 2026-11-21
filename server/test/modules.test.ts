// Modules optionnels (src/modules.ts) : éteints par défaut, allumés par le seul fichier de configuration.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { parseArgs } from '../src/config.ts';
import { runLauncherOrder } from '../src/launcher.ts';
import { DEFAULT_MODELS, DEFAULT_QUOTA, expandPath, loadModules, loadSettings, modulesView, NO_MODULES, NO_UI, parseDelays, parseModels, parseModules, parseQuotaLevels, parseTagVocab, parseTailscale, parseUi, ticketPattern } from '../src/modules.ts';
import { readClaudeUsage, readUsageRaw } from '../src/usage.ts';

const env = { home: 'C:\\Users\\moi', localAppData: 'C:\\Users\\moi\\AppData\\Local', temp: 'C:\\Temp' };
const dir = mkdtempSync(join(tmpdir(), 'sd-modules-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('fichier de configuration', () => {
  test('absent, illisible ou sans « modules » : tout est éteint', () => {
    expect(loadModules(join(dir, 'absent.json'), env)).toEqual(NO_MODULES);
    const bad = join(dir, 'bad.json'); writeFileSync(bad, '{ pas du json');
    expect(loadModules(bad, env)).toEqual(NO_MODULES);
    for (const raw of [null, 3, [], {}, { modules: null }, { modules: [] }, { modules: {} }]) expect(parseModules(raw, env)).toEqual(NO_MODULES);
    expect(modulesView(NO_MODULES)).toEqual({ launcher: false, teams: false, tickets: false, quota: false, automations: false });
  });

  test('un module complet s\'allume, avec ses chemins développés (BOM admis)', () => {
    const f = join(dir, 'ok.json');
    writeFileSync(f, '\ufeff' + JSON.stringify({ modules: { launcher: { root: '%LOCALAPPDATA%\\orchestrateur', cli: '~\\outils\\cli.py' }, teams: { enabled: true },
      tickets: { pattern: 'ABC-\\d{4}' }, quota: { file: '%localappdata%\\orchestrateur\\usage.json' } } }));
    const m = loadModules(f, env);
    expect(m).toEqual({ launcher: { root: 'C:\\Users\\moi\\AppData\\Local\\orchestrateur', cli: 'C:\\Users\\moi\\outils\\cli.py', python: 'python', ticketApi: '', cardsApi: '' }, teams: true,
      tickets: { pattern: 'ABC-\\d{4}' }, quota: { file: 'C:\\Users\\moi\\AppData\\Local\\orchestrateur\\usage.json' }, automations: [] });
    expect(modulesView(m)).toEqual({ launcher: true, teams: true, tickets: true, quota: true, automations: false });
  });

  test('un module mal décrit reste éteint, sans éteindre les autres', () => {
    const m = parseModules({ modules: { launcher: { root: 'relatif\\dossier' }, teams: { enabled: 'oui' }, tickets: { pattern: '(' }, quota: { file: 'C:\\q.json' } } }, env);
    expect(m).toEqual({ launcher: null, teams: false, tickets: null, quota: { file: 'C:\\q.json' }, automations: [] });
    // Lanceur sans commande : la vue marche, les ordres disent pourquoi ils ne partent pas.
    expect(parseModules({ modules: { launcher: { root: 'C:\\l', python: ' py ' } } }, env).launcher).toEqual({ root: 'C:\\l', cli: '', python: 'py', ticketApi: '', cardsApi: '' });
  });

  test('motif de ticket : refusé s\'il ne compile pas ou accepte le vide', () => {
    expect(ticketPattern('HD-\\d{6}')).toBe('HD-\\d{6}');
    for (const v of ['', '(', '\\d*', 'x?', 12, null, 'a'.repeat(201)]) expect(ticketPattern(v)).toBeNull();
  });

  test('chemins : ~ et les trois variables, rien d\'autre', () => {
    expect(expandPath('~', env)).toBe('C:\\Users\\moi');
    expect(expandPath('~/x', env)).toBe(join('C:\\Users\\moi', 'x'));
    expect(expandPath('%TEMP%\\a', env)).toBe('C:\\Temp\\a');
    expect(expandPath('%PATH%\\a', env)).toBe('%PATH%\\a');
    expect(expandPath('C:\\~\\a', env)).toBe('C:\\~\\a');
  });
});

describe('réglages d\'affichage du poste (ui)', () => {
  test('absents ou mal décrits : rien n\'est affiché de plus', () => {
    expect(parseUi({}, env)).toEqual(NO_UI);
    expect(parseUi({ ui: { pathPrefix: 'relatif', prUrl: 'javascript:alert(1)', ticketUrl: 'ftp://x', ticketLabel: 3 } }, env)).toEqual(NO_UI);
    expect(loadSettings(join(dir, 'absent.json'), env)).toEqual({ modules: NO_MODULES, ui: NO_UI, claudeArgs: '', delays: {}, tagVocab: { domaines: [], outils: [] }, peers: [], error: null });
  });
  test('seules des adresses http(s) et un chemin absolu sont gardés', () => {
    expect(parseUi({ ui: { pathPrefix: '%USERPROFILE%\\code', prUrl: 'https://github.com/o/r/pull/', ticketUrl: 'http://tickets.example.com/t/', ticketLabel: '  Ticket  ' } }, env))
      .toEqual({ pathPrefix: 'C:\\Users\\moi\\code', prUrl: 'https://github.com/o/r/pull/', ticketUrl: 'http://tickets.example.com/t/', ticketLabel: 'Ticket', language: '', models: [...DEFAULT_MODELS], quota: { ...DEFAULT_QUOTA }, shortcuts: null });
    expect(parseUi({ ui: { prUrl: 'https://x/"onmouseover="y' } }, env).prUrl).toBe('');
  });
  test('coût des modèles : la table du poste remplace la table par défaut', () => {
    expect(NO_UI.models.find(m => m.match === 'fable')!.cost).toBeGreaterThan(NO_UI.models.find(m => m.match === 'opus')!.cost);
    expect(parseUi({ ui: { models: [{ match: ' Claude-Opus-5-5 ', cost: 1 }, { match: 'fable', label: 'Fable', cost: '3', note: 'n' }] } }, env).models)
      .toEqual([{ match: 'claude-opus-5-5', label: 'claude-opus-5-5', cost: 1, note: '', offer: true }, { match: 'fable', label: 'Fable', cost: 3, note: 'n', offer: true }]);
  });
  test('coût des modèles mal décrit : entrée ignorée, liste vide ⇒ table par défaut', () => {
    expect(parseModels([{ match: '', cost: 1 }, { match: 'x', cost: 0 }, { match: 'y', cost: -2 }, 'z', null])).toEqual([...DEFAULT_MODELS]);
    expect(parseModels([{ match: 'x', cost: 'abc' }, { match: 'ok', cost: 0.5 }])).toEqual([{ match: 'ok', label: 'ok', cost: 0.5, note: '', offer: true }]);
    expect(parseModels([{ match: 'mythos', cost: 2, offer: false }])[0]!.offer).toBe(false);
    expect(parseModels('opus')).toEqual([...DEFAULT_MODELS]);
  });
});

describe('fichier illisible, vocabulaire des tags', () => {
  test('JSON invalide : tout éteint, et l’erreur est dite avec le fichier', () => {
    const f = join(dir, 'casse.json'); writeFileSync(f, '{ "modules": { "teams": { "enabled": true } }, }');
    const s = loadSettings(f, env);
    expect(s.modules).toEqual(NO_MODULES); expect(s.error).toContain(f);
    expect(parseArgs(['--config', f], { USERPROFILE: dir, LOCALAPPDATA: join(dir, 'lad'), TEMP: dir }).configError).toContain(f);
  });
  test('vocabulaire : domaines (sans « Autre ») et outils de la section tagger', () => {
    expect(parseTagVocab({ tagger: { domains: ['Compta', 'Autre', 3], tools: [{ v: 'infra', re: [] }, { re: [] }] } })).toEqual({ domaines: ['Compta'], outils: ['infra'] });
    expect(parseTagVocab({})).toEqual({ domaines: [], outils: [] });
  });
});

describe('autres réglages du poste (quota, délais, Tailscale)', () => {
  test('seuils du quota : entiers 1-100 et warn < alert, sinon 75 / 90', () => {
    expect(parseQuotaLevels(undefined)).toEqual({ warn: 75, alert: 90 });
    expect(parseQuotaLevels({ warn: 60, alert: 85 })).toEqual({ warn: 60, alert: 85 });
    expect(parseQuotaLevels({ alert: 95 })).toEqual({ warn: 75, alert: 95 });
    expect(parseQuotaLevels({ warn: 90, alert: 80 })).toEqual({ warn: 75, alert: 90 });
    expect(parseQuotaLevels({ warn: 0.5, alert: 200 })).toEqual({ warn: 75, alert: 90 });
  });
  test('délais : seules les valeurs valides sont gardées', () => {
    expect(parseDelays({})).toEqual({});
    expect(parseDelays({ delays: { notifyAfterSeconds: 30, notifyDoneAfterMinutes: -1, closedDays: '7' } })).toEqual({ notifyAfterSeconds: 30 });
  });
  test('Tailscale : chemin absolu, "" pour couper, autre chose ignoré', () => {
    expect(parseTailscale({ tailscaleExe: '%LOCALAPPDATA%\\ts\\tailscale.exe' }, env)).toBe(join(env.localAppData, 'ts', 'tailscale.exe'));
    expect(parseTailscale({ tailscaleExe: '' }, env)).toBe('');
    expect(parseTailscale({ tailscaleExe: 'relatif.exe' }, env)).toBeUndefined();
    expect(parseTailscale({}, env)).toBeUndefined();
  });
  test('config.json alimente les délais et Tailscale ; la ligne de commande passe avant', () => {
    const f = join(dir, 'cfg-delays.json');
    writeFileSync(f, JSON.stringify({ delays: { notifyAfterSeconds: 40, closedDays: 30 }, tailscaleExe: '' }));
    const e = { USERPROFILE: dir, LOCALAPPDATA: join(dir, 'lad'), TEMP: dir };
    const c = parseArgs(['--config', f], e);
    expect([c.notifyAfterSeconds, c.notifyDoneAfterMinutes, c.closedDays, c.tailscaleExe]).toEqual([40, 3, 30, '']);
    const c2 = parseArgs(['--config', f, '--notify-after', '5', '--tailscale', 'X:\\t.exe'], e);
    expect([c2.notifyAfterSeconds, c2.tailscaleExe]).toEqual([5, 'X:\\t.exe']);
  });
});

describe('serveur sans aucun module', () => {
  const cfg = parseArgs(['--config', join(dir, 'absent.json')], { USERPROFILE: dir, LOCALAPPDATA: join(dir, 'lad'), TEMP: dir });

  test('--config, puis SD_CONFIG, puis ~/.claude/sessions-desk/config.json', () => {
    expect(cfg.modules).toEqual(NO_MODULES);
    const f = join(dir, 'env.json'); writeFileSync(f, JSON.stringify({ modules: { teams: { enabled: true } } }));
    expect(parseArgs([], { USERPROFILE: dir, SD_CONFIG: f }).modules.teams).toBe(true);
    expect(parseArgs(['--config', join(dir, 'absent.json')], { USERPROFILE: dir, SD_CONFIG: f }).modules.teams).toBe(false);
  });

  test('quota : aucun relevé lu', () => {
    expect(readClaudeUsage(cfg)).toEqual([]);
    expect(readUsageRaw(cfg)).toBeUndefined();
  });

  test('ordre au lanceur : refusé tant qu\'aucune commande n\'est configurée', async () => {
    expect(await runLauncherOrder({ hd: '1', order: 'go' }, {})).toEqual({ error: 'commande du lanceur non configurée (modules.launcher.cli)' });
    expect((await runLauncherOrder({ hd: '1', order: 'go' }, {}, { cli: join(dir, 'absent.py'), python: 'python' })).error).toMatch(/^commande du lanceur introuvable/);
    expect(await runLauncherOrder({ hd: '1', order: 'merge' }, {})).toEqual({ error: 'demande invalide' });
  });
});

describe('vocabulaire des tags : publié par l\'étiqueteur, lu par le serveur', () => {
  test('_vocab.json à côté des tags, filtré ; illisible ou absent ⇒ fichier de règles voisin', async () => {
    const { loadVocab } = await import('../src/state.ts');
    const tags = join(dir, 'session-tags'); const { mkdirSync } = await import('node:fs'); mkdirSync(tags, { recursive: true });
    writeFileSync(join(tags, '_vocab.json'), JSON.stringify({ domaines: ['Compta', '', 3, 'x'.repeat(61)], outils: ['cli'] }));
    expect(loadVocab(tags)).toEqual({ domaines: ['Compta'], outils: ['cli'] });
    writeFileSync(join(tags, '_vocab.json'), '{ pas du json');
    expect(loadVocab(tags)).toEqual(loadVocab());
    expect(loadVocab(join(dir, 'absent'))).toEqual(loadVocab());
  });
});
