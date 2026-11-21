// Page : sessions des autres postes dans la liste (fonctions PURES d'app.js extraites du fichier servi).
// Le point de sécurité : une session d'un autre poste n'est JAMAIS du genre « open » — tout ce qui agit par numéro de
// process sur le poste d'ici (fermer, relancer, envoi groupé, onglet) l'ignore donc sans avoir à y penser.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const js = readFileSync(fileURLToPath(new URL('../../page/app.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const grab = (re: RegExp, name: string): string => { const m = js.match(re); if (!m) throw new Error(name + ' introuvable dans la page'); return m[0]; };
const src = grab(/\nconst isLive = .*\n/, 'isLive') + grab(/\nconst sx = .*\n/, 'sx') + grab(/\nconst cmdKey = .*\n/, 'cmdKey')
  + grab(/\nfunction peerItems\([^)]*\) \{[\s\S]*?\n\}\n/, 'peerItems') + grab(/\nconst peersDown = .*\n/, 'peersDown') + grab(/\nfunction peerPage\([^)]*\) \{[\s\S]*?\n\}\n/, 'peerPage')
  + grab(/\nconst WRITE_ACTIONS = .*\n/, 'WRITE_ACTIONS') + grab(/\nfunction actionsFor\([^)]*\) \{[\s\S]*?\n\}\n/, 'actionsFor');
type Item = Record<string, unknown>;
const page = new Function('const T = (fr, en) => fr;' + src + '\nreturn { isLive, sx, cmdKey, peerItems, peersDown, peerPage, actionsFor };')() as {
  isLive: (it: unknown) => boolean; sx: (it: unknown, path: string) => string; cmdKey: (it: unknown) => string | number;
  peerItems: (peers: unknown, localIds: Set<string>) => Item[]; peersDown: (peers: unknown) => Item[]; peerPage: (self: unknown, it: unknown) => string | null;
  actionsFor: (it: object, ctx?: object) => { id: string; primary: boolean }[];
};

const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002';
const peers = [
  { name: 'portable', ok: true, at: 1, error: null, sessions: [{ pid: 4242, sessionId: A, status: 'idle', statusSince: 900, machine: 'portable' }, { pid: 8, sessionId: B, status: 'busy', statusSince: 950, machine: 'portable' }] },
  { name: 'maison', ok: false, at: 0, error: 'ENOTFOUND', sessions: [] },
];

describe('éléments de la liste', () => {
  test('genre « peer », jamais « open » ; clé = identifiant de session ; poste et ancienneté portés', () => {
    const out = page.peerItems(peers, new Set());
    expect(out.map((i) => [i.kind, i.key, i.machine, i.since])).toEqual([['peer', A, 'portable', 900], ['peer', B, 'portable', 950]]);
  });
  test('une session déjà ouverte ici (même identifiant) n’est pas doublée', () => {
    expect(page.peerItems(peers, new Set([A])).map((i) => i.key)).toEqual([B]);
  });
  test('pair injoignable ou état absent : aucune session, aucune erreur', () => {
    expect(page.peerItems([{ name: 'maison', ok: false, sessions: [{ pid: 1, sessionId: A }] }], new Set())).toEqual([]);
    for (const p of [undefined, null, [], [null], [{ name: 'x', ok: true }]]) expect(page.peerItems(p, new Set())).toEqual([]);
  });
  test('postes injoignables : ceux-là seuls', () => {
    expect(page.peersDown(peers).map((p) => p.name)).toEqual(['maison']);
    expect(page.peersDown(undefined)).toEqual([]);
  });
});

describe('chemins d’API', () => {
  test('session d’ici : chemin inchangé', () => {
    expect(page.sx({ kind: 'open', pid: 12 }, '/api/send?pid=12')).toBe('/api/send?pid=12');
    expect(page.sx(null, '/api/image?path=x')).toBe('/api/image?path=x');
  });
  test('session d’un autre poste : relais du serveur, paramètres gardés', () => {
    const it = { kind: 'peer', machine: 'portable', pid: 4242 };
    expect(page.sx(it, '/api/send?pid=4242')).toBe('/api/peer/portable/send?pid=4242');
    expect(page.sx(it, '/api/transcript?id=' + A)).toBe('/api/peer/portable/transcript?id=' + A);
  });
  test('menu « / » : la clé distingue un pid d’ici du même pid ailleurs', () => {
    expect(page.cmdKey({ pid: 4242 })).toBe(4242);
    expect(page.cmdKey({ pid: 4242, machine: 'portable' })).toBe('portable:4242');
    expect(page.cmdKey(null)).toBe('');
  });
  test('page du poste qui porte la session : le nom de ce poste, première étiquette remplacée', () => {
    expect(page.peerPage('https://bureau.example.ts.net', { machine: 'portable', sessionId: A })).toBe('https://portable.example.ts.net/?sel=' + A);
    for (const self of [null, undefined, '', 'http://localhost:8765']) expect(page.peerPage(self, { machine: 'portable', sessionId: A })).toBeNull();
    expect(page.peerPage('https://bureau.example.ts.net', { sessionId: A })).toBeNull();
  });
});

describe('gestes', () => {
  test('lisible et répondable comme une session ouverte', () => {
    expect(page.isLive({ kind: 'peer' })).toBe(true);
    expect(page.isLive({ kind: 'open' })).toBe(true);
    for (const it of [{ kind: 'closed' }, { kind: 'run' }, { kind: 'pass' }, null, undefined]) expect(page.isLive(it)).toBe(false);
  });
  test('barre d’actions : copier et favori seulement — ni onglet, ni fermeture, ni relance, ni dérivation', () => {
    const l = page.actionsFor({ kind: 'peer', key: A, machine: 'portable', status: 'idle', state: 'idle' }, { canWrite: true });
    expect(l.map((a) => a.id)).toEqual(['copy', 'fav']);
    expect(l.some((a) => a.primary)).toBe(false);
  });
  test('garde-fou : tout ce qui agit par pid sur le poste d’ici ne retient que le genre « open »', () => {
    // Envoi groupé, fermeture groupée, relance groupée, sessions inactives : leurs listes ; onglet, fermeture, relance : leur garde.
    expect(js).toMatch(/\nconst bcEligible = \(\) => allItems\(\)\.filter\(it => it\.kind === 'open' &&/);
    expect(js).toMatch(/\nconst idleList = \(\) => allItems\(\)\.filter\(it => it\.kind === 'open' &&/);
    expect(js).toMatch(/\nconst closable = it => \{\n  const g = it\.git; if \(it\.kind !== 'open' \|\|/);
    expect(js).toMatch(/\nfunction restartPlan\(items\) \{[\s\S]{0,120}?if \(it\.kind !== 'open' \|\|/);
    for (const f of ['openTab', 'relaunch', 'closeSession']) expect(js, f).toMatch(new RegExp(`\\nasync function ${f}\\(it\\) \\{\\n  if \\(!it \\|\\| it\\.kind !== 'open'\\) return;`));
    expect(js).toMatch(/if \(!it \|\| it\.kind !== 'open' \|\| sending\) return;\n  if \(link\.down\)[^\n]*\n  sending = true; say\(T\('« ' \+ label\(it\) \+ ' » : passage sur /);   // modèle de la session
  });
  test('aucun appel par pid ne part hors du relais pour une session lisible d’ailleurs', () => {
    // Lecture d'écran, envois, touches : tous passent par sx(). Les seuls /api/…?pid= restants visent des sessions « open ».
    const direct = [...js.matchAll(/fetch\('\/api\/(send|keys|screen)\?pid=/g)].map((m) => m[1]);
    expect(direct).toEqual(['send']);   // demande Teams entrante : module du poste principal, sessions d'ici seulement
  });
});
