// Autres postes du propriétaire (peers.ts) : lecture de leur état et relais, sans réseau — `fetch` est remplacé.
import { describe, expect, test } from 'vitest';
import { loadSettings } from '../src/modules.ts';
import { PEER_GET, PEER_HEADER, PEER_POST, Peers, parsePeers, peerOrigin, peerRoute, peerSessions } from '../src/peers.ts';

const SELF = 'https://bureau.example.ts.net';
type Call = { url: string; init: RequestInit };
const answer = (body: unknown, status = 200, type = 'application/json; charset=utf-8'): Response =>
  new Response((typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body)) as BodyInit, { status, headers: { 'content-type': type } });
/** Pairs dont les appels sont notés ; `reply` décide de la réponse (ou lève). */
const make = (names: string[], reply: (c: Call) => Response | Promise<Response>, self: string | null = SELF) => {
  const calls: Call[] = [];
  const peers = new Peers(names, () => self, async (url, init) => { const c = { url, init }; calls.push(c); return reply(c); });
  return { peers, calls };
};
const session = (over: object = {}) => ({ pid: 4242, sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', status: 'idle', headless: false, statusSince: 1000, startedAt: 500, createdAt: 400, ...over });

describe('configuration', () => {
  test('`peers` : noms de poste en minuscules, sans doublon ; le reste est ignoré', () => {
    expect(parsePeers({ peers: ['Portable', 'portable', ' maison-2 ', 'a.b', 'x/y', '', 3, null, '-x', 'x-'] })).toEqual(['portable', 'maison-2']);
    for (const raw of [null, {}, [], { peers: 'portable' }, { peers: { a: 1 } }, { modules: { peers: ['portable'] } }]) expect(parsePeers(raw)).toEqual([]);
    expect(parsePeers({ peers: Array.from({ length: 20 }, (_, i) => `poste${i}`) })).toHaveLength(8);
  });
  test('fichier absent : aucun pair', () => {
    expect(loadSettings('Z:\\absent\\config.json', { home: 'Z:\\', localAppData: 'Z:\\', temp: 'Z:\\' }).peers).toEqual([]);
  });
  test('adresse d’un pair : le nom de ce poste, première étiquette remplacée', () => {
    expect(peerOrigin('portable', SELF)).toBe('https://portable.example.ts.net');
    expect(peerOrigin('portable', 'HTTPS://Bureau.Example.TS.net')).toBe('https://portable.example.ts.net');
  });
  test('adresse refusée : identité inconnue, nom invalide, ou le poste lui-même', () => {
    for (const [n, s] of [['portable', null], ['portable', 'http://bureau.example.ts.net'], ['portable', 'https://bureau'], ['a.evil.example', SELF], ['a/b', SELF], ['', SELF], ['bureau', SELF]] as const) expect(peerOrigin(n, s), `${n} ${s}`).toBeNull();
  });
});

describe('routes relayées', () => {
  test('forme du chemin', () => {
    expect(peerRoute('/api/peer/Portable/screen')).toEqual({ name: 'portable', op: 'screen' });
    for (const p of ['/api/peer/portable', '/api/peer/portable/', '/api/peer//screen', '/api/peer/portable/screen/x', '/api/peer/portable/launcher/order', '/api/screen', '/peer/portable/screen']) expect(peerRoute(p), p).toBeNull();
  });
  test('liste fermée : lire et répondre — ni fermer, ni relancer, ni lancer, ni arrêter', () => {
    expect([...PEER_GET].sort()).toEqual(['commands', 'image', 'screen', 'transcript']);
    expect([...PEER_POST].sort()).toEqual(['ack', 'keys', 'send']);
    for (const op of ['close', 'relaunch', 'new', 'stop', 'focus', 'model', 'upload', 'hook', 'state', 'peer']) { expect(PEER_GET.has(op), op).toBe(false); expect(PEER_POST.has(op), op).toBe(false); }
  });
});

describe('sessions d’un pair', () => {
  test('marquées du nom du poste, dates ramenées à l’horloge d’ici', () => {
    const out = peerSessions('portable', { now: 10_000, sessions: [session()] }, 10_250);
    expect(out).toEqual([{ ...session(), machine: 'portable', statusSince: 1250, startedAt: 750, createdAt: 650 }]);
  });
  test('automates sans terminal et entrées mal formées : écartés', () => {
    const out = peerSessions('portable', { now: 1, sessions: [session({ headless: true }), null, 'x', [], { pid: 1 }, { sessionId: 'a' }, session({ pid: 7 })] }, 1);
    expect(out.map((s) => s.pid)).toEqual([7]);
  });
  test('état illisible : aucune session', () => {
    for (const st of [null, 'x', {}, { sessions: 'x' }]) expect(peerSessions('portable', st, 1)).toEqual([]);
  });
});

describe('lecture de l’état des pairs', () => {
  test('sans page qui regarde : aucun appel', async () => {
    const { peers, calls } = make(['portable'], () => answer({ now: Date.now(), sessions: [] }));
    await Promise.all(peers.tick(Date.now()));
    expect(calls).toEqual([]);
    expect(peers.view(Date.now())).toEqual([{ name: 'portable', ok: false, at: 0, error: null, sessions: [] }]);
  });
  test('une page regarde : l’état est lu, avec l’en-tête de serveur à serveur', async () => {
    const { peers, calls } = make(['portable'], () => answer({ now: Date.now(), sessions: [session()] }));
    const now = Date.now(); peers.touch(now);
    await Promise.all(peers.tick(now));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://portable.example.ts.net/api/state');
    expect((calls[0]!.init.headers as Record<string, string>)[PEER_HEADER]).toBe('1');
    const v = peers.view(Date.now());
    expect(v[0]).toMatchObject({ name: 'portable', ok: true, error: null });
    expect(v[0]!.sessions).toHaveLength(1);
    expect(v[0]!.sessions[0]).toMatchObject({ machine: 'portable', pid: 4242 });
  });
  test('rythme : pas deux lectures en moins de 2 s, et plus rien 20 s après la dernière page', async () => {
    const { peers, calls } = make(['portable'], () => answer({ now: Date.now(), sessions: [] }));
    const t = Date.now(); peers.touch(t);
    await Promise.all(peers.tick(t)); await Promise.all(peers.tick(t + 500));
    expect(calls).toHaveLength(1);
    await Promise.all(peers.tick(t + 2100));
    expect(calls).toHaveLength(2);
    await Promise.all(peers.tick(t + 21_000));
    expect(calls).toHaveLength(2);
  });
  test('pair éteint : dit injoignable, sans session, sans lever', async () => {
    const { peers } = make(['portable'], () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); });
    const now = Date.now(); peers.touch(now);
    await Promise.all(peers.tick(now));
    expect(peers.view(Date.now())).toEqual([{ name: 'portable', ok: false, at: 0, error: 'ENOTFOUND', sessions: [] }]);
  });
  test('pair qui refuse (autre propriétaire) : 403 dit, aucune session', async () => {
    const { peers } = make(['portable'], () => answer({ error: 'non' }, 403));
    const now = Date.now(); peers.touch(now);
    await Promise.all(peers.tick(now));
    expect(peers.view(Date.now())[0]).toMatchObject({ ok: false, error: 'accès refusé par ce poste (403)', sessions: [] });
  });
  test('dernier état trop vieux : le pair redevient injoignable, ses sessions disparaissent', async () => {
    const { peers } = make(['portable'], () => answer({ now: Date.now(), sessions: [session()] }));
    const now = Date.now(); peers.touch(now);
    await Promise.all(peers.tick(now));
    const v = peers.view(Date.now() + 11_000);
    expect(v[0]).toMatchObject({ ok: false, sessions: [] });
    expect(v[0]!.at).toBeGreaterThan(0);
  });
  test('identité Tailscale de ce poste inconnue : aucun appel, la raison est dite', async () => {
    const { peers, calls } = make(['portable'], () => answer({}), null);
    const now = Date.now(); peers.touch(now);
    await Promise.all(peers.tick(now));
    expect(calls).toEqual([]);
    expect(peers.view(Date.now())[0]!.error).toBe('identité Tailscale de ce poste inconnue');
  });
  test('aucun pair configuré : éteint', () => {
    const { peers } = make([], () => answer({}));
    expect(peers.enabled).toBe(false);
    expect(peers.tick(Date.now())).toEqual([]);
    expect(peers.has('portable')).toBe(false);
  });
});

describe('relais', () => {
  test('lecture : même route chez le pair, paramètres gardés, pas d’Origin', async () => {
    const { peers, calls } = make(['portable'], () => answer({ text: 'écran' }));
    const r = await peers.forward('portable', 'screen', 'GET', 'pid=4242', '', 'en');
    expect(calls[0]!.url).toBe('https://portable.example.ts.net/api/screen?pid=4242');
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h).toEqual({ [PEER_HEADER]: '1', 'x-sd-lang': 'en' });
    expect(calls[0]!.init.method).toBe('GET');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body.toString('utf8'))).toEqual({ text: 'écran' });
  });
  test('écriture : porte l’origine DU PAIR (sans elle il refuse) et le corps tel quel', async () => {
    const { peers, calls } = make(['portable'], () => answer({ error: null }));
    await peers.forward('portable', 'send', 'POST', 'pid=4242', '{"text":"go"}', undefined);
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.origin).toBe('https://portable.example.ts.net');
    expect(h['content-type']).toBe('application/json');
    expect(calls[0]!.init.body).toBe('{"text":"go"}');
  });
  test('le refus du pair est rendu tel quel (code et corps)', async () => {
    const { peers } = make(['portable'], () => answer({ error: 'action refusée à distance' }, 403));
    const r = await peers.forward('portable', 'send', 'POST', 'pid=1', '{}', undefined);
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body.toString('utf8'))).toEqual({ error: 'action refusée à distance' });
  });
  test('image : type et octets rendus tels quels', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { peers } = make(['portable'], () => answer(png, 200, 'image/png'));
    const r = await peers.forward('portable', 'image', 'GET', 'path=C%3A%5Cx.png', '', undefined);
    expect(r.type).toBe('image/png');
    expect([...r.body]).toEqual([...png]);
  });
  test('pair injoignable : 502 avec la raison, jamais d’exception', async () => {
    const { peers } = make(['portable'], () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); });
    const r = await peers.forward('portable', 'screen', 'GET', 'pid=1', '', undefined);
    expect(r.status).toBe(502);
    expect(JSON.parse(r.body.toString('utf8')).error).toBe('poste « portable » injoignable : pas de réponse');
  });
});
