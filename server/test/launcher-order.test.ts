// Ordres au lanceur depuis le détail d'un run : orderArgs (Get-LauncherOrderArgs du .ps1) et
// runLauncherOrder contre une FAUSSE commande du lanceur (SD_LAUNCHER_CLI) — jamais une vraie commande.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { orderArgs, runLauncherOrder } from '../src/launcher.ts';

describe('orderArgs : la commande tapée pour chaque ordre', () => {
  test('go, avec ou sans consigne ; consigne derrière « -- », blancs ramenés à une espace', () => {
    expect(orderArgs({ hd: '991903', order: 'go' })).toEqual(['go', '991903']);
    expect(orderArgs({ hd: 991903, order: 'go', text: '  charge les agents\r\n à part ' })).toEqual(['go', '991903', '--', 'charge les agents à part']);
    expect(orderArgs({ hd: '1', order: 'go', text: '--dry-run' })).toEqual(['go', '1', '--', '--dry-run']);
  });
  test('merge seulement avec confirm === true', () => {
    expect(orderArgs({ hd: '5', order: 'merge', confirm: true })).toEqual(['merge', '5']);
    expect(orderArgs({ hd: '5', order: 'merge' })).toBeNull();
    expect(orderArgs({ hd: '5', order: 'merge', confirm: 'true' })).toBeNull();
    expect(orderArgs({ hd: '5', order: 'merge', confirm: true, text: 'ignoré' })).toEqual(['merge', '5']);
  });
  test('relire, reprendre, sauter la recette ; verdict ok|partiel|faux avec commentaire', () => {
    expect(orderArgs({ hd: '7', order: 'review' })).toEqual(['review', '7']);
    expect(orderArgs({ hd: '7', order: 'rework' })).toEqual(['rework', '7']);
    expect(orderArgs({ hd: '7', order: 'recette-skip' })).toEqual(['recette', 'skip', '7']);
    expect(orderArgs({ hd: '7', order: 'verdict', value: 'partiel', text: 'cause juste, correctif faux' })).toEqual(['verdict', '7', 'partiel', '--', 'cause juste, correctif faux']);
    expect(orderArgs({ hd: '7', order: 'verdict', value: 'bof' })).toBeNull();
  });
  test('décision de la Tech : option, choix techniques en --choice, texte derrière « -- »', () => {
    expect(orderArgs({ hd: '42', order: 'decide', value: 'go', choices: { portee: 'pit' }, text: ' garder  l’ordre ' }))
      .toEqual(['decide', '42', 'go', '--choice', 'portee=pit', '--', 'garder l’ordre']);
    expect(orderArgs({ hd: '42', order: 'decide', value: 'plus-tard' })).toEqual(['decide', '42', 'plus-tard']);
    expect(orderArgs({ hd: '42', order: 'decide', value: 'non', choices: {}, text: 'doublon' })).toEqual(['decide', '42', 'non', '--', 'doublon']);
    for (const j of [{ hd: '42', order: 'decide' }, { hd: '42', order: 'decide', value: 'GO' }, { hd: '42', order: 'decide', value: '--x' },
      { hd: '42', order: 'decide', value: 'go', choices: { 'a=b': 'c' } }, { hd: '42', order: 'decide', value: 'go', choices: { a: '--dry-run' } }]) expect(orderArgs(j)).toBeNull();
  });
  test('abandon : jamais sans le mot pour le demandeur, passé derrière « -- »', () => {
    expect(orderArgs({ hd: '111111', order: 'abandon', text: '  corrigé à la main,\r\n plus rien à faire ' })).toEqual(['abandon', '111111', '--', 'corrigé à la main, plus rien à faire']);
    expect(orderArgs({ hd: '111111', order: 'abandon', text: '--dry-run' })).toEqual(['abandon', '111111', '--', '--dry-run']);
    for (const j of [{ hd: '111111', order: 'abandon' }, { hd: '111111', order: 'abandon', text: ' \n ' }, { hd: '111111', order: 'abandon', text: 'x'.repeat(2001) }]) expect(orderArgs(j)).toBeNull();
  });
  test('demande invalide : numéro, ordre inconnu ou en majuscules, texte trop long, corps non objet', () => {
    for (const j of [{ hd: '0', order: 'go' }, { hd: '12a', order: 'go' }, { hd: '../1', order: 'go' }, { hd: '1234567890', order: 'go' }, { hd: '1', order: 'GO' },
      { hd: '1', order: 'pause' }, { hd: '1', order: 'go', text: 'x'.repeat(2001) }, null, [1], 'go']) expect(orderArgs(j)).toBeNull();
  });
});

describe('runLauncherOrder : contre une fausse commande du lanceur', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-order-'));
  const cli = join(dir, 'fake_cli.py'), log = join(dir, 'argv.json');
  writeFileSync(cli, [
    'import json, sys',
    `open(${JSON.stringify(log)}, "w", encoding="utf-8").write(json.dumps(sys.argv[1:], ensure_ascii=False))`,
    'if "999999" in sys.argv: print("HD-999999 : pas de correctif lancé — développement déjà pr-open (PR #1)"); sys.exit(1)',
    'print(f"HD-{sys.argv[2]} : feu vert enregistré — correctif en file"); print("  consigne : é")',
  ].join('\n'), 'utf8');
  const env = { ...process.env, SD_LAUNCHER_CLI: cli };
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('accepté : arguments passés tels quels (sans shell), sortie rendue en UTF-8', async () => {
    const r = await runLauncherOrder({ hd: '42', order: 'go', text: 'a "b" & c' }, env);
    expect(r).toEqual({ ok: true, message: 'HD-42 : feu vert enregistré — correctif en file\n  consigne : é' });
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual(['go', '42', '--', 'a "b" & c']);
  });
  test('refusé : la 1re ligne de la commande dit pourquoi', async () => {
    expect(await runLauncherOrder({ hd: '999999', order: 'merge', confirm: true }, env)).toEqual({ error: 'HD-999999 : pas de correctif lancé — développement déjà pr-open (PR #1)' });
  });
  test('demande invalide ou commande absente : rien n\'est lancé', async () => {
    expect(await runLauncherOrder({ hd: '1', order: 'merge' }, env)).toEqual({ error: 'demande invalide' });
    expect((await runLauncherOrder({ hd: '1', order: 'go' }, { ...env, SD_LAUNCHER_CLI: join(dir, 'absent.py') })).error).toMatch(/^commande du lanceur introuvable/);
  });
});
