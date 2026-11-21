// La classe ConScreen du pilote est celle du serveur PowerShell historique, à l'octet près. Sauté sans legacy/ (ce
// dépôt) ; là où legacy/ est présent, un correctif de l'un doit être porté dans l'autre — ce test échoue sinon.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { REPO } from './helpers.ts';

test.skipIf(!existsSync(join(REPO, 'legacy', 'sessions-dashboard.ps1')))('driver/src/ConScreen.cs = le bloc ConScreen de legacy/sessions-dashboard.ps1', () => {
  // Fins de ligne ramenées à LF : legacy/** est extrait tel quel (-text), driver/** selon core.autocrlf du poste.
  const lf = (s: string) => s.replace(/\r\n/g, '\n');
  const ps1 = lf(readFileSync(join(REPO, 'legacy', 'sessions-dashboard.ps1'), 'utf8'));
  const head = "Add-Type -TypeDefinition @'\nusing System; using System.Text; using System.Runtime.InteropServices;\npublic static class ConScreen {";
  const start = ps1.indexOf(head);
  expect(start, 'bloc ConScreen introuvable dans le .ps1').toBeGreaterThan(0);
  const from = ps1.indexOf('\n', start) + 1;
  const to = ps1.indexOf('\n// Recherche plein texte', from);
  expect(to, 'fin du bloc ConScreen introuvable').toBeGreaterThan(from);
  const fromPs1 = ps1.slice(from, to + 1);

  const cs = lf(readFileSync(join(REPO, 'driver', 'src', 'ConScreen.cs'), 'utf8'));
  // En-tête propre au pilote : commentaires et #nullable avant le premier « using ».
  const body = cs.slice(cs.indexOf('using System;'));
  expect(body).toBe(fromPs1);
});
