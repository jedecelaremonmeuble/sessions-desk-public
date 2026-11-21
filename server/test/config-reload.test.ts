// Rechargement à chaud de config.json (config.ts : applySettings, reloadConfig, watchConfig).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { parseArgs, reloadConfig, watchConfig } from '../src/config.ts';

const root = mkdtempSync(join(tmpdir(), 'sd-reload-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
/** Un fichier de configuration neuf, et le serveur (Config) qui l'a lu au démarrage. */
function boot(content: unknown, extra: string[] = []) {
  const file = join(root, `config-${++n}.json`);
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  const env = { USERPROFILE: join(root, 'home'), LOCALAPPDATA: join(root, 'lad'), TEMP: join(root, 'tmp') } as NodeJS.ProcessEnv;
  const cfg = parseArgs(['--port', '18999', '--config', file, '--tailscale', '', ...extra], env);
  const write = (c: unknown): void => writeFileSync(file, typeof c === 'string' ? c : JSON.stringify(c));
  return { cfg, file, write };
}

describe('reloadConfig', () => {
  test('affichage, délais, options de claude, motif des tickets, dossiers : appliqués sans redémarrage', () => {
    const { cfg, write } = boot({ ui: { quota: { warn: 75, alert: 90 } }, delays: { closedDays: 14 }, claudeArgs: '' });
    write({ ui: { quota: { warn: 50, alert: 80 }, models: [{ match: 'opus', cost: 1 }] }, delays: { closedDays: 3, notifyAfterSeconds: 60 }, claudeArgs: '--model sonnet',
      modules: { tickets: { pattern: 'ABC-\\d{4}' } }, newSession: { folders: ['C:\\code\\repo'] } });
    const line = reloadConfig(cfg);
    expect(line).toBe('config.json relu');
    expect(cfg.ui.quota).toEqual({ warn: 50, alert: 80 });
    expect(cfg.ui.models.map((m) => m.match)).toEqual(['opus']);
    expect(cfg.closedDays).toBe(3);
    expect(cfg.notifyAfterSeconds).toBe(60);
    expect(cfg.notifyDoneAfterMinutes).toBe(3);   // absent : la valeur par défaut
    expect(cfg.claudeArgs).toBe('--model sonnet');
    expect(cfg.modules.tickets).toEqual({ pattern: 'ABC-\\d{4}' });
    expect(cfg.newFolders).toEqual(['C:\\code\\repo']);
    expect(cfg.configRestart).toEqual([]);
  });
  test('une option de la ligne de commande garde la main', () => {
    const { cfg, write } = boot({ claudeArgs: '--model opus' }, ['--claude-args', '--model haiku', '--closed-days', '7']);
    write({ claudeArgs: '--model sonnet', delays: { closedDays: 30 } });
    reloadConfig(cfg);
    expect(cfg.claudeArgs).toBe('--model haiku');
    expect(cfg.closedDays).toBe(7);
  });
  test('modules, Tailscale et autres postes : signalés « au prochain démarrage », sans être appliqués', () => {
    const { cfg, write } = boot({ modules: { teams: { enabled: false } } });
    write({ modules: { teams: { enabled: true }, quota: { source: 'usage-probe' } }, peers: ['laptop'] });
    const line = reloadConfig(cfg);
    expect(cfg.configRestart).toEqual(['modules.teams', 'modules.quota', 'peers']);
    expect(line).toMatch(/au prochain démarrage : modules\.teams, modules\.quota, peers$/);
    expect(cfg.modules.teams).toBe(false);
    expect(cfg.modules.quota).toBeNull();
    // Revenu à l'état du démarrage : plus rien à signaler.
    write({ modules: { teams: { enabled: false } } });
    reloadConfig(cfg);
    expect(cfg.configRestart).toEqual([]);
  });
  test('devenu illisible : on le dit, et les réglages en service restent', () => {
    const { cfg, write } = boot({ ui: { quota: { warn: 60, alert: 70 } }, modules: { tickets: { pattern: 'ABC-\\d{4}' } } });
    write('{ "ui": ');
    const line = reloadConfig(cfg);
    expect(line).toMatch(/^config\.json illisible, réglages précédents gardés/);
    expect(cfg.configError).not.toBeNull();
    expect(cfg.configErrorKept).toBe(true);
    expect(cfg.ui.quota).toEqual({ warn: 60, alert: 70 });
    expect(cfg.modules.tickets).toEqual({ pattern: 'ABC-\\d{4}' });
    write({ ui: { quota: { warn: 60, alert: 70 } }, modules: { tickets: { pattern: 'ABC-\\d{4}' } } });
    reloadConfig(cfg);
    expect(cfg.configError).toBeNull();
    expect(cfg.configErrorKept).toBe(false);
  });
  test('illisible au démarrage puis corrigé : l’affichage s’applique, les modules attendent le redémarrage', () => {
    const { cfg, write } = boot('{ oops');
    expect(cfg.configError).not.toBeNull();
    expect(cfg.configErrorKept).toBe(false);
    write({ ui: { ticketLabel: 'Ticket' }, modules: { teams: { enabled: true } } });
    reloadConfig(cfg);
    expect(cfg.configError).toBeNull();
    expect(cfg.ui.ticketLabel).toBe('Ticket');
    expect(cfg.configRestart).toEqual(['modules.teams']);
  });
  test('les écarts au schéma suivent le fichier', () => {
    const { cfg, write } = boot({});
    write({ ui: { qouta: {} } });
    expect(reloadConfig(cfg)).toBe('config.json relu (1 réglage(s) ignoré(s))');
    expect(cfg.configWarnings).toEqual(['ui.qouta : clé inconnue, ignorée']);
  });
});

describe('watchConfig', () => {
  test('relit le fichier quand il change', async () => {
    const { cfg, write } = boot({ ui: { ticketLabel: 'A' } });
    const lines: string[] = [];
    const stop = watchConfig(cfg, (l) => lines.push(l), 50);
    try {
      await new Promise((r) => setTimeout(r, 120));
      write({ ui: { ticketLabel: 'Bb' } });
      for (let i = 0; i < 60 && !lines.length; i++) await new Promise((r) => setTimeout(r, 50));
      expect(lines).toEqual(['config.json relu']);
      expect(cfg.ui.ticketLabel).toBe('Bb');
    } finally { stop(); }
  });
});
