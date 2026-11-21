// Page : un long texte collé devient une pièce jointe (pastedAsFile, extraite de app.js et exécutée seule) au lieu
// d'être tapé dans la session — aplati sur une ligne, tronqué à 4 000 caractères et découpé en morceaux de 1 024.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { PAGE_DIR } from './helpers.ts';

const js = readFileSync(join(PAGE_DIR, 'app.js'), 'utf8').replace(/\r\n/g, '\n');   // poste en autocrlf : fins de ligne CRLF
function source(name: string, sig: string): string {
  const m = new RegExp(`\\nfunction ${name}\\(${sig}\\) \\{[\\s\\S]*?\\n\\}\\n`).exec(js);
  if (!m) throw new Error(`${name} introuvable dans la page`);
  return m[0];
}
const consts = /\nconst PASTE_FILE_CHARS = [^\n]*\n/.exec(js)?.[0] ?? '';
const pastedAsFile = new Function(`${consts}${source('pastedAsFile', 'text, now')}; return pastedAsFile;`)() as
  (text: unknown, now: Date) => { name: string; type: string; lines: number; text: string } | null;
const at = new Date(2026, 0, 2, 7, 5, 9);

describe('long texte collé ⇒ pièce jointe', () => {
  test('court et sur une ligne : collé tel quel', () => {
    expect(pastedAsFile('rebase sur main et dis-moi où tu en es', at)).toBeNull();
    expect(pastedAsFile('a\nb\nc\nd', at)).toBeNull();                         // 4 lignes : encore tapé
    expect(pastedAsFile('x'.repeat(999), at)).toBeNull();
  });
  test('vide ou blancs seuls : rien à joindre', () => {
    expect(pastedAsFile('', at)).toBeNull();
    expect(pastedAsFile(null, at)).toBeNull();
    expect(pastedAsFile(' \n\n\n\n\n ', at)).toBeNull();
  });
  test('1 000 caractères ou plus : fichier texte, même sur une seule ligne', () => {
    const f = pastedAsFile('x'.repeat(1000), at)!;
    expect(f).toMatchObject({ name: 'texte-colle-070509.txt', type: 'text/plain', lines: 1 });
    expect(f.text).toHaveLength(1000);
  });
  test('5 lignes ou plus : fichier, retours à la ligne gardés (CRLF ramenés à LF)', () => {
    const f = pastedAsFile('un\r\ndeux\r\ntrois\r\nquatre\r\ncinq\r\n', at)!;
    expect(f.lines).toBe(5);                                                  // le saut final ne compte pas
    expect(f.text).toBe('un\ndeux\ntrois\nquatre\ncinq\n');
  });
  test('JSON valide : fichier .json, texte intact (indentation comprise)', () => {
    const json = JSON.stringify({ planId: 'p-1', advisors: Array.from({ length: 80 }, (_, i) => ({ initiales: 'A' + i, kept: i })) }, null, 4);
    const f = pastedAsFile(json, at)!;
    expect(f).toMatchObject({ name: 'texte-colle-070509.json', type: 'application/json' });
    expect(f.text).toBe(json);
    expect(f.text.length).toBeGreaterThan(4000);                              // au-delà de l'ancienne troncature
  });
  test('ressemble à du JSON sans en être (coupé) : fichier .txt', () => {
    const f = pastedAsFile('{\n  "a": 1,\n  "b": 2,\n  "c": 3,\n  "d": [', at)!;
    expect(f).toMatchObject({ type: 'text/plain' });
    expect(f.name.endsWith('.txt')).toBe(true);
  });
});

test('la pièce collée est annoncée comme texte collé dans le message', () => {
  const lists: Record<string, unknown[]> = {
    k: [{ path: 'C:\\u\\texte-colle-070509.json', pasted: 120 }, { path: 'C:\\u\\x.png', img: true }, { path: 'C:\\u\\court.txt', pasted: 1 }],
  };
  const withAttachments = new Function('attList', `${source('withAttachments', 'key, text')}; return withAttachments;`)((k: string) => lists[k]) as
    (key: string, text: string) => string;
  expect(withAttachments('k', ' regarde ça ')).toBe(
    'regarde ça Texte collé (120 lignes) : "C:\\u\\texte-colle-070509.json" Capture : "C:\\u\\x.png" Texte collé (1 ligne) : "C:\\u\\court.txt"');
});

describe('zone vide, texte collé joint : il devient le message', () => {
  const lists: Record<string, unknown[]> = {
    un: [{ path: 'C:/u/a.txt', pasted: 40 }],
    deux: [{ path: 'C:/u/a.txt', pasted: 40 }, { path: 'C:/u/b.txt', pasted: 9 }],
    capture: [{ path: 'C:/u/x.png', img: true }],
    attente: [{ path: null, pasted: 40 }],
  };
  const withAttachments = new Function('attList', `${source('withAttachments', 'key, text')}; return withAttachments;`)((k: string) => lists[k]) as
    (key: string, text: string) => string;
  test('un texte collé : consigne de le lire et de faire ce qu’il demande, puis sa référence', () => {
    expect(withAttachments('un', '  ')).toBe(
      'Mon message est dans le texte collé joint : lis-le en entier et fais ce qu’il demande, comme si je l’avais tapé. Texte collé (40 lignes) : "C:/u/a.txt"');
  });
  test('plusieurs textes collés : consigne au pluriel', () => {
    expect(withAttachments('deux', '')).toMatch(/^Mon message est dans les textes collés joints : lis-les en entier/);
  });
  test('un message tapé garde la main : pas de consigne ajoutée', () => {
    expect(withAttachments('un', 'résume')).toBe('résume Texte collé (40 lignes) : "C:/u/a.txt"');
  });
  test('capture seule, ou pièce pas encore reçue : rien d’ajouté', () => {
    expect(withAttachments('capture', '')).toBe('Capture : "C:/u/x.png"');
    expect(withAttachments('attente', '')).toBe('');
  });
});

test('les zones de réponse ne tronquent plus en silence (le serveur refuse au-delà de 4 000, le texte reste)', () => {
  expect(js).not.toMatch(/promptArea\('sendtext'\); inp\.maxLength/);
  expect(js).not.toMatch(/promptArea\('bc-text'\); tx\.maxLength/);
});
