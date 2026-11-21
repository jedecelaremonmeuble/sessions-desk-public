// Modèle pour CETTE session seulement : le menu /model rejoué à l'écran (curseur, touche « s »), jamais Entrée —
// elle enregistrerait le choix comme réglage par défaut. Faux pilote à écrans scriptés : aucune console réelle.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Actions, parseModelMenu, pickModel } from '../src/actions.ts';
import type { Dashboard } from '../src/state.ts';

const BAR = '─'.repeat(40);
const PROMPT = ['● ok', '', BAR, '❯ ', BAR, '  ⏵⏵ accept edits on'].join('\n');
const FOOT = '  s to use this session only · Enter to save · Esc to cancel';
const ROWS = ['Default (recommended)  Opus 5.5 · Best for everyday, complex tasks', 'Opus 5.5               For complex work', 'Fable 5.2              For your toughest challenges',
  'Sonnet 5.5             Most efficient', 'Haiku 5.5 ✔            Fastest for quick answers'];
const menu = (cur: number, foot = FOOT): string => ['  Select model', '  Your pick is the default for new sessions.', '',
  ...ROWS.map((r, i) => `  ${i === cur ? '❯' : ' '} ${i + 1}.  ${r}`), '    ▸   More models', '', '  ◐ Medium effort (default) ←/→ to adjust', '', foot].join('\n');
const SWITCH = ['  Switch model?', '  Your next response will be slower and use more tokens', '', '  ❯ 1. Yes, switch to Sonnet 5.5', '    2. No, go back', '', '  Enter to confirm · Esc to cancel'].join('\n');

describe('parseModelMenu', () => {
  test('lignes numérotées, curseur, choix « cette session seulement »', () => {
    const m = parseModelMenu(menu(4))!;
    expect(m.opts.map((o) => o.label)).toEqual(['Default (recommended)', 'Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5']);
    expect(m.cur).toBe(4); expect(m.sessionOnly).toBe(true);
  });
  test('pied « Enter to set as default » (Claude Code 2.1.311) : reconnu', () => {
    const scr = ['   Select model', '   Switch between Claude models. Your pick becomes the default for new sessions.', '',
      '     1.  Default (recommended)  Opus 5.5 · Best for everyday, complex tasks', '     2.  Opus 5.5               For complex work and everyday tasks',
      '     3.  Fable 5.2              For your toughest challenges', '     4.  Sonnet 5.5             Most efficient for simpler tasks',
      '     5.  Haiku 5.5              Fastest for quick answers', '   ❯ 6.  Fable 5.1 ✔            Most capable for your hardest and longest-running tasks',
      '      … +8 models', '', '   ● High effort (default) ←/→ to adjust', '', '   Enter to set as default · s to use this session only · Esc to cancel'].join('\n');
    const m = parseModelMenu(scr)!;
    expect(m.opts.map((o) => o.label)).toEqual(['Default (recommended)', 'Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5', 'Fable 5.1']);
    expect(m.cur).toBe(5); expect(m.sessionOnly).toBe(true); expect(pickModel(m, 'sonnet')).toBe(3);
  });
  test('menu sans la touche « s » : reconnu, mais sans choix de session', () => { expect(parseModelMenu(menu(0, '  Enter to save · Esc to cancel'))!.sessionOnly).toBe(false); });
  test('invite ordinaire ou autre dialogue : pas ce menu', () => { expect(parseModelMenu(PROMPT)).toBeNull(); expect(parseModelMenu('')).toBeNull(); });
  test('le modèle demandé : jamais la ligne « Default », même si elle le nomme', () => {
    const m = parseModelMenu(menu(4))!;
    expect(pickModel(m, 'opus')).toBe(1); expect(pickModel(m, 'Sonnet')).toBe(3); expect(pickModel(m, 'mythos')).toBe(-1);
  });
});

describe('sessionModel', () => {
  const PID = 4242; let dir: string, status: string, typed: unknown[], screens: string[];
  // Chaque lecture d'écran consomme le script ; le dernier écran reste affiché.
  const actions = (): Actions => {
    const a = new Actions({
      sf: (name: string) => join(dir, name),
      openSessions: async () => [{ pid: PID, sessionId: 'sess-1', title: 'essai', status }],
      setSeen: () => undefined,
      driver: { call: async (op: string, args: Record<string, unknown>) => {
        if (op === 'read') return screens.length > 1 ? screens.shift() : screens[0];
        typed.push(op === 'send' ? args.line : (args.items as string[]).map((x) => x.replace('\u0001', '#')).join(' '));
        return 0;
      } },
    } as unknown as Dashboard);
    a.modelWaitMs = 0; a.modelStepMs = 0; return a;
  };
  const logged = (): Record<string, unknown> => JSON.parse(readFileSync(join(dir, 'sessions-dashboard-sent.jsonl'), 'utf8').trim().split('\n').at(-1)!);
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sd-model-')); status = 'idle'; typed = []; screens = []; });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('curseur amené sur le modèle, « s », question « Switch model? » validée', async () => {
    screens = [menu(4), menu(3), SWITCH, PROMPT];
    expect(await actions().sessionModel(PID, 'sonnet')).toBeNull();
    expect(typed).toEqual(['/model', '#Up', 's', '#Enter']);
    expect(logged()).toMatchObject({ command: '/model', sessionOnly: true, code: 0, model: 'Sonnet 5.5' });
  });
  test('plusieurs lignes à descendre, sans question de confirmation', async () => {
    screens = [menu(1), menu(4), PROMPT];
    expect(await actions().sessionModel(PID, 'haiku')).toBeNull();
    expect(typed).toEqual(['/model', '#Down #Down #Down', 's']);
  });
  test('modèle déjà sous le curseur : « s » directement', async () => {
    screens = [menu(4), menu(4), PROMPT];
    expect(await actions().sessionModel(PID, 'haiku')).toBeNull();
    expect(typed).toEqual(['/model', 's']);
  });
  test('menu sans « cette session seulement » : Échap, jamais Entrée', async () => {
    screens = [menu(4, '  Enter to save · Esc to cancel')];
    expect(await actions().sessionModel(PID, 'sonnet')).toMatch(/cette session seulement/);
    expect(typed).toEqual(['/model', '#Esc']);
  });
  test('modèle absent du menu : Échap, les modèles offerts sont nommés', async () => {
    screens = [menu(4)];
    expect(await actions().sessionModel(PID, 'mythos')).toMatch(/absent du menu \(.*Sonnet 5\.5.*\)/);
    expect(typed).toEqual(['/model', '#Esc']);
  });
  test('curseur pas arrivé sur le modèle : Échap, rien n\'est choisi', async () => {
    screens = [menu(4), menu(4)];
    expect(await actions().sessionModel(PID, 'sonnet')).toMatch(/curseur/);
    expect(typed).toEqual(['/model', '#Up', '#Esc']);
  });
  test('menu jamais apparu : aucune touche à l\'aveugle', async () => {
    screens = [PROMPT];
    expect(await actions().sessionModel(PID, 'sonnet')).toMatch(/non reconnu/);
    expect(typed).toEqual(['/model']);
  });
  test('session au travail ou nom farfelu : rien n\'est tapé', async () => {
    expect(await actions().sessionModel(PID, 'opus; rm')).toBe('modèle invalide');
    status = 'busy'; expect(await actions().sessionModel(PID, 'opus')).toMatch(/pas inactive/);
    expect(typed).toEqual([]);
  });
});
