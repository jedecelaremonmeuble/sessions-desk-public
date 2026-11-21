// La page entière doit se compiler. Les autres tests de la page n'en extraient que des fonctions : une erreur de syntaxe
// ailleurs dans app.js passait la CI et donnait une page vide (liste des sessions jamais remplie).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { expect, test } from 'vitest';

test('page/app.js se compile', () => {
  const js = readFileSync(fileURLToPath(new URL('../../page/app.js', import.meta.url)), 'utf8');
  expect(() => new Script(js, { filename: 'page/app.js' })).not.toThrow();
});
