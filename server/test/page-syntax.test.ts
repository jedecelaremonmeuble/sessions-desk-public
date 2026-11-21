// Page : le script doit au moins se compiler. Une vraie fin de ligne dans une chaîne entre apostrophes (au lieu de
// « \n ») casse TOUTE la page — rien ne s'affiche — sans qu'aucun test de rendu ne le voie s'il lit le source en texte.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { expect, test } from 'vitest';
import { PAGE_DIR } from './helpers.ts';

test('app.js se compile (aucune erreur de syntaxe)', () => {
  const js = readFileSync(join(PAGE_DIR, 'app.js'), 'utf8');
  expect(() => new Script(js, { filename: 'app.js' })).not.toThrow();
});
