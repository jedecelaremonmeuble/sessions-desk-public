// Livraison refusée : « J'ai relu, livrer » envoie `merge <hd> --adopt-head <sha>`, et le diff est lu par
// `delivery-diff` contre une FAUSSE commande du lanceur (SD_LAUNCHER_CLI) — jamais la vraie.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { lookupDeliveryDiff, orderArgs, runLauncherOrder } from '../src/launcher.ts';

const SHA = 'b'.repeat(40);

describe('orderArgs : merge avec le sha relu', () => {
  test('adoptHead valide ⇒ --adopt-head ; absent ou null ⇒ merge simple', () => {
    expect(orderArgs({ hd: '111111', order: 'merge', confirm: true, adoptHead: SHA })).toEqual(['merge', '111111', '--adopt-head', SHA]);
    expect(orderArgs({ hd: '111111', order: 'merge', confirm: true, adoptHead: null })).toEqual(['merge', '111111']);
  });
  test('sha invalide, en majuscules, option déguisée ou sans confirmation ⇒ rien', () => {
    for (const adoptHead of ['abc', SHA.toUpperCase(), '--dry-run', SHA + 'b', 42, ''.padEnd(40, 'g')])
      expect(orderArgs({ hd: '111111', order: 'merge', confirm: true, adoptHead })).toBeNull();
    expect(orderArgs({ hd: '111111', order: 'merge', adoptHead: SHA })).toBeNull();
  });
});

describe('lookupDeliveryDiff : contre une fausse commande du lanceur', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-diff-'));
  const cli = join(dir, 'fake_cli.py'), log = join(dir, 'argv.json');
  writeFileSync(cli, [
    'import json, sys',
    `open(${JSON.stringify(log)}, "w", encoding="utf-8").write(json.dumps(sys.argv[1:], ensure_ascii=False))`,
    'if sys.argv[2] == "1": print("bruit avant"); print("{pas du json"); sys.exit(0)',
    'if sys.argv[2] == "2": sys.exit(3)',
    'print("journal : lecture de la PR")',
    `print(json.dumps({"hd": int(sys.argv[2]), "changed": True, "prHead": "${SHA}", "commits": [{"sha": "${SHA}", "title": "fix: é"}], "files": []}, ensure_ascii=False))`,
  ].join('\n'), 'utf8');
  const env = { ...process.env, SD_LAUNCHER_CLI: cli };
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('la DERNIÈRE ligne JSON est rendue telle quelle, arguments passés sans shell', async () => {
    const d = await lookupDeliveryDiff('111111', env);
    expect(d).toEqual({ hd: 111111, changed: true, prHead: SHA, commits: [{ sha: SHA, title: 'fix: é' }], files: [] });
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual(['delivery-diff', '111111']);
  });
  test('sortie illisible ou commande en échec : une erreur, jamais une exception', async () => {
    expect(await lookupDeliveryDiff('1', env)).toEqual({ error: 'diff illisible' });
    expect((await lookupDeliveryDiff('2', env)).error).toMatch(/^diff illisible : le lanceur a échoué/);
  });
  test('numéro invalide ou commande absente : rien n\'est lancé', async () => {
    expect(await lookupDeliveryDiff('../1', env)).toEqual({ error: 'demande invalide' });
    expect((await lookupDeliveryDiff('5', { ...env, SD_LAUNCHER_CLI: join(dir, 'absent.py') })).error).toMatch(/^commande du lanceur introuvable/);
  });
  test('l\'ordre « J\'ai relu, livrer » tape bien --adopt-head', async () => {
    const r = await runLauncherOrder({ hd: '111111', order: 'merge', confirm: true, adoptHead: SHA }, env);
    expect(r.ok).toBe(true);
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual(['merge', '111111', '--adopt-head', SHA]);
  });
});
