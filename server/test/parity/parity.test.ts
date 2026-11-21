// PARITÉ PS ↔ Node.
//  1. « PS = Node » : les deux serveurs tournent EN MÊME TEMPS sur le même profil factice ; chaque route en lecture et
//     une matrice de codes d'accès sont comparées, après normalisation des seuls champs qui dépendent de l'instant.
//  2. Puis le MÊME jeu de tests contre chacun (SD_PARITY_SERVERS=ps,node) : ceux de legacy/sessions-dashboard-tests.ps1,
//     plus les écritures (envoi, touches, favoris…) sur les consoles de test, et les règles invisibles (ordre, dates,
//     troncatures) écrites en tests AVANT d'être portées.
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PAGE_DIR, REPO, TestConsole } from '../helpers.ts';
import { request } from 'node:http';
import { buildFixture, call, DIALOG, KINDS, killTabsOn, post, resetState, sleep, startServer, TS_HOST, TS_ORIGIN, TS_OWNER, waitState, type Fixture, type Kind, type Srv } from './harness.ts';

let fx: Fixture;
beforeAll(async () => { fx = await buildFixture(); }, 120000);
afterAll(() => {
  // Filet : aucun test ne doit avoir ouvert d'onglet Windows Terminal (nouvelle session, réouverture) sur le profil factice.
  const leaked = fx ? killTabsOn(fx.root) : [];
  fx?.cleanup();
  expect(leaked, 'onglets ouverts par les tests (fermés)').toEqual([]);
});

const sortBy = <T>(a: T[], k: (x: T) => string): T[] => [...a].sort((x, y) => (k(x) < k(y) ? -1 : k(x) > k(y) ? 1 : 0));

/** Ce qui dépend de l'instant (ou d'un ordre non déterministe côté PowerShell) est neutralisé. */
function normalize(route: string, j: any): any {
  const c = JSON.parse(JSON.stringify(j));
  if (route === 'state') {
    delete c.now; delete c.modules; delete c.ui; delete c.promptSuggestion; delete c.server;   // modules, ui : réglages du poste, que chaque serveur tient de son côté ; promptSuggestion, server : Node seul, le .ps1 ne bouge plus
    for (const s of c.sessions) { if (s.stale) s.statusSince = '<corrigé>'; delete s.createdAt; delete s.spin; }   // createdAt, spin : Node seul (tri par création)
    for (const q of c.quota ?? []) delete q.active;                           // compte connecté : Node seul
  }
  if (route === 'closed') for (const s of c.closed) delete s.createdAt;
  if (route === 'folders') for (const f of c.folders) if (f.last > fx.t0) f.last = '<maintenant>';
  if (route.startsWith('launcher')) { delete c.now; if (c.runs) c.runs = sortBy(c.runs, (r: any) => r.dir); }
  if (route.startsWith('find')) delete c.ms;
  if (route === 'alerts') c.alerts = sortBy(c.alerts, (a: any) => a.key);
  return c;
}

describe.runIf(KINDS.includes('ps') && KINDS.includes('node'))('PS = Node (mêmes réponses, même profil)', () => {
  const srv: Partial<Record<Kind, Srv>> = {};
  beforeAll(async () => {
    resetState(fx);
    [srv.ps, srv.node] = await Promise.all([startServer('ps', fx), startServer('node', fx)]);
    // Correction du busy périmé de E par l'écran (2 lectures à ≥ 3 s) : attendue des deux côtés avant de comparer.
    await Promise.all([srv.ps, srv.node].map((s) => waitState(s!, (st) => st.sessions.find((x: any) => x.sessionId === fx.ids.E)?.stale === 'screen')));
  }, 120000);
  afterAll(async () => { await Promise.all([srv.ps?.stop(), srv.node?.stop()]); });

  const both = async (path: string, o?: Parameters<typeof call>[2]): Promise<[any, any]> => {
    const [a, b] = await Promise.all([call(srv.ps!, path, o), call(srv.node!, path, o)]);
    expect(b.code, `${path} : code Node`).toBe(a.code);
    return [a.body ? JSON.parse(a.body) : null, b.body ? JSON.parse(b.body) : null];
  };
  const routes: [string, () => string][] = [
    ['state', () => '/api/state'], ['closed', () => '/api/closed'], ['folders', () => '/api/folders'],
    ['launcher', () => '/api/launcher'], ['launcher-week', () => '/api/launcher?hours=168'], ['find', () => '/api/find?q=coffre%20Vaultwarden'],
    ['find-vide', () => '/api/find?q=a'],
    ['find-tag', () => '/api/find?q=coffre%20domaine:compta'], ['find-tag-autre', () => '/api/find?q=coffre%20domaine:telephonie'],
    ['find-tag-seul', () => '/api/find?q=tag:compta'], ['tag-vocab', () => '/api/tag-vocab'], ['whoami', () => '/api/whoami'], ['alerts', () => '/api/test-launcher-alerts'],
    ['screen-A', () => `/api/screen?pid=${fx.pids.A}`], ['screen-B', () => `/api/screen?pid=${fx.pids.B}`], ['screen-D', () => `/api/screen?pid=${fx.pids.D}`],
    ['transcript-A', () => `/api/transcript?id=${fx.ids.A}`], ['transcript-A-after', () => `/api/transcript?id=${fx.ids.A}&after=5`],
  ];
  for (const [name, path] of routes) {
    test(`${name} identique`, async () => {
      const [a, b] = await both(path());
      expect(normalize(name, b)).toEqual(normalize(name, a));
    });
  }

  // Tags de l'étiqueteur : identiques (ci-dessus), et justes — deux serveurs d'accord sur une erreur passeraient sinon.
  test('tags : lus, filtrés, null sans fichier valide', async () => {
    const [st] = await both('/api/state'); const [cl] = await both('/api/closed');
    const tagsOf = (id: string) => (st.sessions.find((s: any) => s.sessionId === id) ?? cl.closed.find((s: any) => s.sessionId === id))?.tags;
    expect(tagsOf(fx.ids.A)).toEqual([
      { axis: 'origine', v: 'interactive', src: 'entrypoint' }, { axis: 'domaine', v: 'Téléphonie', src: 'hd' },
      { axis: 'fonction', v: 'power-dial', src: '' }, { axis: 'hd', v: 'HD-555555', src: 'prompt' }, { axis: 'fonction', v: 'coffre-fort', src: 'manuel' }]);
    expect(tagsOf(fx.ids.H)).toEqual([{ axis: 'domaine', v: 'Compta', src: 'fichiers' }]);
    expect(tagsOf(fx.ids.C)).toEqual([{ axis: 'domaine', v: 'Compta', src: 'manuel' }]);
    for (const k of ['B', 'D', 'E'] as const) expect(tagsOf(fx.ids[k]), k).toBeNull();
  });
  test('recherche : les filtres de tags restreignent les conversations, valeur exacte', async () => {
    const ids = (r: any) => r.hits.map((h: any) => h.sessionId);
    expect(ids((await both('/api/find?q=coffre%20domaine:compta'))[0])).toEqual([fx.ids.H]);
    expect(ids((await both('/api/find?q=coffre%20tag:compta'))[0])).toEqual([fx.ids.H]);
    expect(ids((await both('/api/find?q=coffre%20domaine:compt'))[0])).toEqual([]);
    const [only] = await both('/api/find?q=domaine:compta');
    expect(only.hits).toEqual([]); expect(only.tags).toEqual(['domaine:compta']);
  });

  // Matrice d'accès : chaque combinaison méthode × chemin × origine × en-têtes distants doit donner le MÊME code.
  const remoteH = { 'x-forwarded-for': '100.64.0.9', 'tailscale-user-login': 'autre@example.com' };
  const ownerH = { 'x-forwarded-for': '100.64.0.9', 'tailscale-user-login': TS_OWNER };
  const site = (v: string): Record<string, string> => ({ 'sec-fetch-site': v });
  const matrix: [string, string, string | null, Record<string, string>?, string?][] = [
    // Propriétaire à distance : lecture ; écriture depuis la page du tailnet seulement ; jamais l'arrêt ni le hook.
    ['GET', '/', null, ownerH], ['GET', '/api/state', null, ownerH], ['GET', '/api/whoami', null, ownerH], ['GET', '/api/ping', null, ownerH],
    ['POST', '/api/fav?id=x', 'self', ownerH], ['POST', '/api/fav?id=x', TS_ORIGIN, ownerH], ['POST', '/api/fav?id=x', TS_ORIGIN, remoteH],
    ['GET', '/api/stop', null, ownerH], ['POST', '/api/stop', TS_ORIGIN, ownerH], ['POST', '/api/hook', null, ownerH], ['GET', '/api/launcher/file?path=x', null, ownerH],
    ['GET', '/api/state', null, { 'tailscale-user-login': TS_OWNER.toUpperCase() }], ['GET', '/api/state', null, { 'x-forwarded-for': 'relais' }],
    // Requête venue d'un autre site (Sec-Fetch-Site) : jamais l'API ; la page reste ouvrable par un lien.
    ['GET', '/api/stop', null, site('cross-site')], ['GET', '/api/stop', null, site('same-site')], ['GET', '/api/state', null, site('cross-site')],
    ['GET', '/api/state', null, site('Same-Site')], ['GET', '/api/whoami', null, site('cross-site')], ['POST', '/api/fav?id=x', 'self', site('cross-site')],
    ['POST', '/api/hook', null, site('cross-site')], ['GET', '/api/nexistepas', null, site('cross-site')], ['GET', '/api/state', null, { ...ownerH, ...site('cross-site') }],
    ['GET', '/', null, site('cross-site')], ['GET', '/app.js', null, site('cross-site')], ['GET', '/app.css', null, site('same-site')],
    ['GET', '/api/state', null, site('same-origin')], ['GET', '/api/state', null, site('none')], ['POST', '/api/fav?id=x', 'self', site('same-origin')],
    ['GET', '/', null], ['GET', '/app.js', null], ['GET', '/app.css', null], ['GET', '/index.html', null], ['GET', '/sessions-dashboard.ps1', null],
    ['GET', '/app.js/../../sessions-dashboard.ps1', null], ['GET', '/api/nexistepas', null], ['POST', '/api/nexistepas', 'self'],
    ['GET', '/api/state', 'http://evil.example'], ['POST', '/api/fav?id=x', null], ['POST', '/api/fav?id=x', 'http://evil.example'],
    ['GET', '/api/fav?id=x', 'self'], ['POST', '/api/tags', null], ['GET', '/api/tags', 'self'], ['GET', '/api/tag-vocab', null, remoteH], ['POST', '/api/stop', 'self'], ['GET', '/api/screen?pid=1', null], ['GET', '/api/screen?pid=-1', null],
    ['GET', '/api/screen?pid=abc', null], ['GET', '/api/transcript?id=..%5C..%5Csettings', null], ['GET', '/api/transcript?id=00000000-0000-0000-0000-000000000000', null],
    ['POST', '/api/hook', 'self'], ['GET', '/api/hook', null], ['GET', '/api/upload', null], ['POST', '/api/upload', null], ['POST', '/api/upload', 'http://evil.example'],
    ['GET', '/', null, remoteH], ['GET', '/api/state', null, remoteH], ['GET', '/api/whoami', null, remoteH], ['POST', '/api/fav?id=x', 'self', remoteH],
    ['GET', '/api/stop', null, remoteH], ['POST', '/api/hook', null, remoteH], ['GET', '/api/test-busy', null, remoteH], ['GET', '/api/launcher/file?path=x', null, remoteH],
    ['GET', '/api/ping', null, { 'x-forwarded-for': 'relais' }], ['POST', '/api/send-many', 'self', remoteH],
    ['GET', '/api/launcher/file?path=..%5Cstate.json', null], ['GET', '/api/launcher/file?path=C%3A%5CWindows%5Cwin.ini', null],
    ['GET', '/api/state', null, {}, '127.0.0.1'], ['GET', '/api/state', null, {}, 'autre.example.ts.net'],
    ['GET', '/api/launcher?hours=abc', null], ['GET', '/api/test-busy?ms=10', null], ['GET', '/api/test-busy?ms=x', null],
    ['POST', '/api/focus?pid=1', 'self'], ['POST', '/api/send', 'self'], ['POST', '/api/keys?pid=abc', 'self'], ['POST', '/api/close', 'self'],
    ['POST', '/api/hide', 'self'], ['POST', '/api/reopen-many', 'self'], ['POST', '/api/new', 'self'], ['POST', '/api/git-refresh?pid=1', 'self'],
    ['POST', '/api/launcher/order', 'self'], ['POST', '/api/launcher/order', null], ['POST', '/api/launcher/order', 'http://evil.example'], ['GET', '/api/launcher/order', 'self'],
    ['POST', '/api/launcher/order', 'self', remoteH],
    ['GET', '/api/launcher/hd?hd=abc', null], ['GET', '/api/launcher/hd?hd=0', null, remoteH], ['POST', '/api/launcher/hd?hd=1', 'self'],
    ['GET', '/api/launcher/delivery-diff?hd=abc', null], ['GET', '/api/launcher/delivery-diff?hd=0', null, remoteH], ['POST', '/api/launcher/delivery-diff?hd=1', 'self'],
  ];
  test('matrice d\'accès : mêmes codes et mêmes corps', async () => {
    const diffs: string[] = [];
    for (const [method, path, origin, headers, host] of matrix) {
      const r: Record<string, { code: number; body: string }> = {};
      for (const k of ['ps', 'node'] as const) {
        const s = srv[k]!;
        const o = origin === 'self' ? s.base : origin;
        const x = await call(s, path, { method, origin: o, headers: headers ?? {}, ...(host ? { host: host.includes(':') ? host : `${host}:${s.port}` } : {}), ...(method === 'POST' ? { body: '' } : {}) });
        // /api/state.modules et .ui : réglages du poste, que chaque serveur tient de son côté — hors comparaison.
        let raw = x.body;
        if (raw.length > 300 && raw.startsWith('{')) { try { const o = JSON.parse(raw); delete o.modules; delete o.ui; delete o.promptSuggestion; delete o.server; for (const s of [...(o.sessions ?? []), ...(o.closed ?? [])]) delete s.createdAt; for (const q of o.quota ?? []) delete q.active; raw = JSON.stringify(o); } catch { /* pas du JSON : comparé tel quel */ } }
        r[k] = { code: x.code, body: x.code === 400 && x.headers['content-type']?.toString().includes('html') ? '<http.sys>' : raw.length > 300 ? `<${raw.length} o>` : raw };
      }
      if (r.ps!.code !== r.node!.code || r.ps!.body !== r.node!.body) diffs.push(`${method} ${path} ${origin ?? ''} ${JSON.stringify(headers ?? {})} ${host ?? ''} : PS ${r.ps!.code} ${r.ps!.body} | Node ${r.node!.code} ${r.node!.body}`);
    }
    expect(diffs).toEqual([]);
  }, 120000);

  test('état git (/api/git-refresh) : même lecture de git status --porcelain=v2, branche, retard, dernier commit', async () => {
    for (const k of ['ps', 'node'] as const) expect((await post(srv[k]!, `/api/git-refresh?pid=${fx.pids.C}`)).body).toBe('{"ok":true}');
    const [a, b] = await Promise.all((['ps', 'node'] as const).map((k) => waitState(srv[k]!, (st) => st.sessions.find((x: any) => x.sessionId === fx.ids.C)?.git, 60000)));
    const strip = (g: any): any => ({ ...g, at: '<instant>' });
    expect(strip(b)).toEqual(strip(a));
    expect(a).toMatchObject({ branch: 'feat/essai', worktree: false, nFiles: 3, base: null, merged: false });
    expect(a.files.map((f: any) => f.k).sort()).toEqual(['modifié', 'nouveau', 'supprimé']);
  }, 90000);

  test('focus : console hors Windows Terminal ⇒ onglet introuvable (3), des deux côtés', async () => {
    const [a, b] = await Promise.all((['ps', 'node'] as const).map(async (k) => (await post(srv[k]!, `/api/focus?pid=${fx.pids.A}`)).json()));
    expect(a).toEqual({ code: 3 }); expect(b).toEqual(a);
  }, 30000);

  // Relais : méthode × chemin × origine × Host d'origine × en-têtes. Seul le nom du poste sur le tailnet est transmis.
  test('relais (port+1) : mêmes codes et mêmes corps', async () => {
    const cases: [string, string, string | null, string, Record<string, string>?][] = [
      ['GET', '/api/state', null, TS_HOST], ['GET', '/api/whoami', null, TS_HOST], ['GET', '/api/state', null, TS_HOST, ownerH], ['GET', '/api/whoami', null, TS_HOST, ownerH],
      ['GET', '/', null, TS_HOST.toUpperCase() + ':443', ownerH], ['GET', `/api/transcript?id=${fx.ids.A}`, null, TS_HOST, ownerH], ['GET', '/api/stop', null, TS_HOST, ownerH],
      ['POST', '/api/fav?id=x&on=1', 'self', TS_HOST, ownerH], ['POST', '/api/send-many', TS_ORIGIN, TS_HOST, ownerH], ['POST', '/api/send-many', TS_ORIGIN, TS_HOST, remoteH],
      ['GET', '/api/state', null, 'evil.example'], ['GET', '/api/state', null, 'evil.example', ownerH], ['GET', '/api/whoami', null, 'evil.example'], ['GET', '/', null, 'evil.example'],
      ['GET', '/api/stop', null, 'evil.example'], ['POST', '/api/send-many', TS_ORIGIN, 'evil.example', ownerH], ['GET', '/api/state', null, `${TS_HOST}.evil.example`, ownerH],
      ['GET', '/api/state', null, `evil.example.${TS_HOST}`, ownerH], ['GET', '/api/state', null, 'localhost:<relais>', ownerH], ['GET', '/api/state', null, '127.0.0.1:<relais>', ownerH],
      ['GET', '/api/state', null, 'localhost:<port>', ownerH], ['GET', '/api/state', null, `${TS_HOST}:abc`, ownerH], ['GET', '/api/state', null, `${TS_HOST}.`, ownerH],
    ];
    const diffs: string[] = [];
    for (const [method, path, origin, host, headers] of cases) {
      const r = await Promise.all((['ps', 'node'] as const).map(async (k) => {
        const s = srv[k]!;
        const x = await call(s, path, { method, port: s.port + 1, host: host.replace('<relais>', String(s.port + 1)).replace('<port>', String(s.port)), headers: headers ?? {},
          origin: origin === 'self' ? s.base : origin, ...(method === 'POST' ? { body: '{}' } : {}) });
        return `${x.code} ${x.body.length > 300 ? `<${x.headers['content-type']}>` : x.body}`;
      }));
      if (r[0] !== r[1]) diffs.push(`${method} ${path} ${origin ?? ''} ${host} ${JSON.stringify(headers ?? {})} : PS ${r[0]} | Node ${r[1]}`);
    }
    expect(diffs).toEqual([]);
  });
});

describe.each(KINDS)('serveur %s', (kind) => {
  let s: Srv;
  let state: any;
  const sentLog = (): any[] => { const f = join(fx.claude, 'state', 'sessions-dashboard-sent.jsonl'); return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l.replace(/^\uFEFF/, ''))) : []; };
  beforeAll(async () => {
    resetState(fx);
    const t = Date.now();
    s = await startServer(kind, fx);
    state = await waitState(s, (st) => st);
    (globalThis as any)[`startMs_${kind}`] = Date.now() - t;
  }, 120000);
  afterAll(async () => { await s?.stop(); });

  describe('page et routes', () => {
    test('index.html, app.js (tel que sur disque), app.css', async () => {
      expect((await call(s, '/')).body).toContain('src="/app.js"');
      const js = readFileSync(join(PAGE_DIR, 'app.js'), 'utf8');
      const r = await call(s, '/app.js'); expect(r.code).toBe(200); expect(r.body).toBe(js); expect(r.headers['content-type']).toBe('text/javascript; charset=utf-8');
      expect(r.headers['cache-control']).toBe('no-store');
      expect((await call(s, '/app.css')).body).toContain('--bg');
    });
    test('fichier hors page ⇒ 404 (403 s\'il remonte au-dessus de la racine), route inconnue ⇒ 404', async () => {
      expect((await call(s, '/sessions-dashboard.ps1')).code).toBe(404);
      expect((await call(s, '/app.js/../../sessions-dashboard.ps1')).code).toBe(403);   // http.sys : au-dessus de la racine
      expect((await call(s, '/a/../app.js')).code).toBe(200);
      expect((await call(s, '/api/nexistepas')).code).toBe(404);
    });
    test('premier état servi vite après le démarrage', () => { expect((globalThis as any)[`startMs_${kind}`]).toBeLessThan(30000); });
  });

  describe('état', () => {
    const sess = (k: keyof Fixture['ids']): any => state.sessions.find((x: any) => x.sessionId === fx.ids[k]);
    test('sessions vivantes seulement (process claude), dans l\'ordre des fichiers', () => {
      const pids = state.sessions.map((x: any) => x.pid);
      expect(new Set(pids)).toEqual(new Set(Object.values(fx.pids)));
      expect(pids).toEqual([...pids].sort((a: number, b: number) => (String(a).toUpperCase() < String(b).toUpperCase() ? -1 : 1)));
    });
    test('titre (custom-title avant ai-title), PR, modèle du dernier message (<synthetic> ignoré), taille du contexte', () => {
      const a = sess('A');
      expect(a.title).toBe('Titre choisi pour A'); expect(a.pr).toBe(42); expect(a.prUrl).toBe('https://github.com/o/r/pull/42');
      expect(a.prInfo).toBeNull();    // -NoBackground : l'état des PR n'est lu que par la surveillance
      expect(a.model).toBe('claude-fable-5-2[1m]');
      expect(a.tokens).toBe(3210);
      expect(a.reply).toBe('erreur');   // le message <synthetic> compte pour la réponse, pas pour le modèle
    });
    test('worktree : le plus récent cité dans au moins 2 messages ; recette lancée dans une commande', () => {
      const a = sess('A');
      expect(a.wt).toMatch(/\\work\\\.claude\\worktrees\\wt-un$/);
      expect(a.gitDir).toBe(a.wt);
      expect(a.recette).toBe(true);
      expect(sess('B').recette).toBe(false);
    });
    test('réponse de plus de 900 caractères : « … » + les 900 derniers', () => {
      const b = sess('B'); expect(b.reply.startsWith('… ')).toBe(true); expect(b.reply.length).toBe(902); expect(b.reply.endsWith(' fin')).toBe(true);
    });
    test('prompts : les 6 derniers, texte coupé à 400', () => {
      const a = sess('A'); expect(a.prompts.map((p: any) => p.text)).toEqual(['prompt 3 de A', 'prompt 4 de A', 'prompt 5 de A', 'prompt 6 de A', 'prompt 7 de A', 'prompt 8 de A']);
      expect(a.lastPrompt).toBe('prompt 8 de A'); expect(sess('B').lastPrompt).toBe('L'.repeat(400));
    });
    test('sujet (topicHd) : dernier HD cité dans TOUS les prompts, rien s\'il est déjà dans le premier', () => {
      expect(sess('A').topicHd).toBe('HD-333333'); expect(sess('C').topicHd).toBeNull(); expect(sess('B').topicHd).toBeNull();
    });
    test('« à relire » (done) : inactive et fin de tour après le dernier « vu »', () => {
      expect(sess('A').done).toBe(true); expect(sess('B').done).toBe(false); expect(sess('D').done).toBe(false);
    });
    test('automate (entrypoint sdk-cli) : headless, sans proposition ; sessions de terminal jamais headless', () => {
      expect(sess('G').headless).toBe(true); expect(sess('G').suggestion).toBeNull();
      expect(state.sessions.filter((x: any) => x.headless && x.entrypoint === 'cli')).toEqual([]);
    });
    test('proposition de prompt lue à l\'écran pour les sessions inactives', () => {
      expect(sess('B').suggestion).toBe('ouvre la PR et lance la CI'); expect(sess('A').suggestion).toBeNull(); expect(sess('C').suggestion).toBeNull();
      expect(sess('D').suggestion).toBeNull();
    });
    test('busy périmé : corrigé par l\'écran (stale = screen) ; au travail à l\'écran : reste busy', async () => {
      const e = await waitState(s, (st) => { const x = st.sessions.find((y: any) => y.sessionId === fx.ids.E); return x?.stale === 'screen' ? x : null; });
      expect(e.status).toBe('idle'); expect(e.statusSince).toBeGreaterThanOrEqual(fx.t0);
      expect(sess('F').status).toBe('busy'); expect(sess('F').stale).toBeNull();
    });
    test('favoris, masquées, notifications, relances, quota (dates en ms)', () => {
      expect(state.favs).toEqual([fx.ids.A, fx.ids.H]); expect(state.hidden).toEqual([fx.ids.I]);
      expect(state.notifs.map((n: any) => n.kind)).toEqual(['waiting', 'done']); expect(state.restarts).toHaveLength(1);
      const q = state.quota.find((x: any) => x.uuid === 'uuid-1');
      expect(q.weeklyResetsAt).toBe(Math.floor((fx.t0 + 86400000) / 1000) * 1000); expect(q.limits).toEqual([{ kind: 'weekly_scoped', pct: 43, model: 'Fable', resetsAt: q.weeklyResetsAt, active: true, severity: 'warn' },
        { kind: 'weekly_scoped', pct: 95, model: 'Opus', resetsAt: q.weeklyResetsAt, active: false, severity: 'critical' }]);
      const q2 = state.quota.find((x: any) => x.uuid === 'uuid-2');
      expect(q2.limits).toEqual([]); expect(q2.measuredAt).toBe(Date.UTC(2026, 10, 16, 17, 20, 7)); expect(q2.weeklyResetsAt).toBeNull();
    });
    test('après un redémarrage de Windows : la session vue vivante avant est proposée', () => {
      expect(state.reboot.sessions.map((x: any) => x.sessionId)).toEqual([fx.ids.H]);
      expect(state.reboot.sessions[0]).toMatchObject({ title: 'Session fermée H', pr: null });
    });
  });

  describe('fermées, dossiers', () => {
    test('fermées : titrées seulement, la plus récente d\'abord, moins de 14 jours', async () => {
      const c = (await call(s, '/api/closed')).json();
      expect(c.days).toBe(14);
      expect(c.closed.map((x: any) => x.sessionId)).toEqual([fx.ids.H, fx.ids.I]);
      expect(c.closed[0].prompts.map((p: any) => p.text)).toEqual(['reprise de H']);
    });
    test('dossiers proposés : ceux des sessions (encore présents), le plus récent d\'abord', async () => {
      const f = (await call(s, '/api/folders')).json().folders;
      expect(f.map((x: any) => x.path)).toEqual([fx.work, join(fx.work, '..', 'autre')]);
    });
  });

  describe('écran et conversation', () => {
    test('écran : texte et proposition ; pid sans fiche ⇒ 400', async () => {
      const r = (await call(s, `/api/screen?pid=${fx.pids.B}`)).json();
      expect(r.text).toContain('Console de test du pilote'); expect(r.suggestion).toBe('ouvre la PR et lance la CI');
      expect((await call(s, '/api/screen?pid=1')).code).toBe(400);
    });
    test('conversation : identifiant invalide ⇒ 400, inconnu ⇒ 404 ; rendu filtré', async () => {
      expect((await call(s, '/api/transcript?id=..%5C..%5Csettings')).code).toBe(400);
      expect((await call(s, '/api/transcript?id=00000000-0000-4000-8000-000000000000')).code).toBe(404);
      const j = (await call(s, `/api/transcript?id=${fx.ids.A}`)).json();
      expect(j.items.map((i: any) => i.r)).toEqual(['user', 'assistant', 'tool', 'assistant', 'assistant', 'assistant', 'assistant']);
      expect(j.items[2]).toMatchObject({ r: 'tool', n: 'Bash' });
      expect(j.start).toBe(0);
    });
    test('conversation longue : tranche d\'1 Mo, « plus ancien », suite (after), ligne en cours ignorée, texte coupé à 30 000', async () => {
      const id = 'abcdef01-0000-4000-8000-0000000000aa';
      const dir = join(fx.claude, 'projects', `test-${kind}`); mkdirSync(dir, { recursive: true });
      const f = join(dir, `${id}.jsonl`);
      const filler = JSON.stringify({ type: 'assistant', timestamp: 't', message: { content: [{ type: 'text', text: 'remplissage ' + 'x'.repeat(2000) }] } });
      writeFileSync(f, [JSON.stringify({ type: 'user', timestamp: 't', message: { content: 'premier message' } }),
        JSON.stringify({ type: 'assistant', timestamp: 't', message: { content: [{ type: 'text', text: 'y'.repeat(31234) }] } }),
        ...Array(700).fill(filler), JSON.stringify({ type: 'user', message: { content: 'dernier message' } }), '{"type":"user","message":{"ro'].join('\n'));
      const last = (await call(s, `/api/transcript?id=${id}`)).json();
      expect(last.items.at(-1).t).toBe('dernier message'); expect(last.start).toBeGreaterThan(0); expect(last.end).toBeLessThan(last.size);
      let before = last.start; let all: any[] = [];
      for (let i = 0; i < 10 && before > 0; i++) { const j = (await call(s, `/api/transcript?id=${id}&before=${before}`)).json(); all = [...j.items, ...all]; before = j.start; }
      expect(before).toBe(0);
      expect(all[0].t).toBe('premier message');
      expect(all[1].t.startsWith('y'.repeat(30000) + ' […] (')).toBe(true); expect(all[1].t.replace(/\D/g, '')).toBe('1234');
      expect((await call(s, `/api/transcript?id=${id}&after=${last.end}`)).json()).toMatchObject({ items: [], end: last.end });
      expect((await call(s, `/api/transcript?id=${id}&after=999999999`)).json().reset).toBe(true);
    });
  });

  describe('envoi (consoles de test)', () => {
    test('send : texte nettoyé (sauts de ligne, tabulations, contrôles), Entrée à part, journalisé, « vu »', async () => {
      const a = fx.consoles.A!; const before = a.keys().length; const t0 = Date.now();
      const r = (await post(s, `/api/send?pid=${fx.pids.A}`, { text: `  ${kind} ligne\r\nsuite\tfin\u0007  ` })).json();
      const took = Date.now() - t0;
      expect(r).toEqual({ error: null });
      await sleep(300);
      const k = a.keys().slice(before); expect(k.map((x) => x.ch).join('')).toBe(`${kind} ligne suite fin\r`);
      expect(took).toBeGreaterThanOrEqual(450);   // la pause avant l'Entrée, mesurée du côté de l'envoi (voir driver-console)
      const e = sentLog().at(-1); expect(e).toMatchObject({ pid: fx.pids.A, sessionId: fx.ids.A, code: 0, text: `${kind} ligne suite fin`, suggested: false });
      const st = await waitState(s, (x) => x.sessions.find((y: any) => y.sessionId === fx.ids.A && !y.done));
      expect(st.done).toBe(false);
    });
    test('send : 4 000 caractères au plus ; vide refusé ; rien de tapé', async () => {
      const a = fx.consoles.A!; const before = a.keys().length;
      expect((await post(s, `/api/send?pid=${fx.pids.A}`, { text: 'z'.repeat(4001) })).json().error).toBe('message trop long (4 000 caractères au plus)');
      expect((await post(s, `/api/send?pid=${fx.pids.A}`, { text: ' \r\n\t ' })).json().error).toBe('message vide');
      expect((await post(s, `/api/send?pid=${fx.pids.A}`, '')).json().error).toBe('message vide');
      await sleep(200); expect(a.keys().length).toBe(before);
    });
    test('send : session au travail, invite vide ⇒ message EN FILE (tapé, journalisé queued) ; jamais une proposition', async () => {
      const f = fx.consoles.F!; const before = f.keys().length;
      expect((await post(s, `/api/send?pid=${fx.pids.F}`, { text: 'x', suggestion: true })).json().error).toBe("la session n'est pas inactive (statut busy)");
      expect((await post(s, `/api/send?pid=${fx.pids.F}`, { text: `${kind} en file` })).json()).toEqual({ error: null });
      await sleep(300); expect(f.keys().slice(before).map((x) => x.ch).join('')).toBe(`${kind} en file\r`);
      expect(sentLog().at(-1)).toMatchObject({ pid: fx.pids.F, code: 0, text: `${kind} en file`, suggested: false, queued: true });
    });
    test('send : session en attente, invite non vide, inconnue ⇒ refus, rien de tapé', async () => {
      expect((await post(s, `/api/send?pid=${fx.pids.D}`, { text: 'x' })).json().error).toBe("la session n'est pas inactive (statut waiting)");
      const c = fx.consoles.C!;
      expect((await post(s, `/api/send?pid=${fx.pids.C}`, { text: 'x' })).json().error).toBe("l'invite de la session n'est pas vide (brouillon, menu ou dialogue ouvert)");
      await sleep(200); expect(c.keys()).toEqual([]);
      expect((await post(s, '/api/send?pid=4000001', { text: 'x' })).json().error).toBe('session introuvable');   // fiche présente, process mort
      expect((await post(s, '/api/send?pid=4000003', { text: 'x' })).code).toBe(400);
    });
    // Le serveur Node accepte une proposition coupée (Tab, Entrée — voir suggestion-cut.test.ts), mais seulement si
    // elle est encore telle quelle à l'écran ; le serveur d'origine la refuse d'emblée.
    test('proposition : coupée (…) absente de l\'écran refusée ; changée refusée ; exacte lancée', async () => {
      const b = fx.consoles.B!; const before = b.keys().length;
      expect((await post(s, `/api/send?pid=${fx.pids.B}`, { text: 'ouvre la PR et…', suggestion: true })).json().error).toMatch(kind === 'node' ? /a changé/ : /coupée/);
      expect((await post(s, `/api/send?pid=${fx.pids.B}`, { text: 'ouvre la PR', suggestion: true })).json().error).toBe("la proposition a changé à l'écran");
      expect((await post(s, `/api/send?pid=${fx.pids.B}`, { text: 'ouvre la PR et lance la CI', suggestion: true })).json().error).toBeNull();
      await sleep(300); expect(b.keys().slice(before).map((x) => x.ch).join('')).toBe('ouvre la PR et lance la CI\r');
      expect(sentLog().at(-1)).toMatchObject({ suggested: true });
    });
    test('message groupé : par session, garde-fous d\'envoi', async () => {
      const r = (await post(s, '/api/send-many', { pids: [1, fx.pids.F, '0'], text: 'test' })).json();
      expect(r.results).toEqual([{ pid: 1, title: null, error: 'session introuvable' }, { pid: fx.pids.F, title: 'Titre de F', error: "la session n'est pas inactive (statut busy)" }]);
    });
  });

  describe('dialogues (touches)', () => {
    test('session qui attend, option visée à l\'écran : touches tapées dans l\'ordre, journalisées', async () => {
      const d = fx.consoles.D!; const before = d.keys().length;
      const r = (await post(s, `/api/keys?pid=${fx.pids.D}`, { keys: [{ k: 'Down' }, { t: '2' }, { k: 'Enter' }], expect: '2. Non' })).json();
      expect(r.error).toBeNull();
      await sleep(300); expect(d.keys().slice(before).map((x) => x.vk)).toEqual([0x28, 0, 0x0d]);
      expect(sentLog().at(-1)).toMatchObject({ keys: ['#Down', '2', '#Enter'], expect: '2. Non', code: 0 });
    });
    test('option plus à l\'écran, session qui n\'attend pas, touche inconnue, rien à envoyer, trop de touches', async () => {
      const d = fx.consoles.D!; const before = d.keys().length;
      expect((await post(s, `/api/keys?pid=${fx.pids.D}`, { keys: [{ t: '1' }], expect: '3. Peut-être' })).json().error).toBe("le dialogue a changé : « 3. Peut-être » n'est plus à l'écran");
      expect((await post(s, `/api/keys?pid=${fx.pids.A}`, { keys: [{ t: '1' }] })).json().error).toBe("la session n'attend plus de réponse (statut idle)");
      // Session inactive : une touche n'est acceptée qu'avec un texte attendu, relu à l'écran comme pour un dialogue.
      expect((await post(s, `/api/keys?pid=${fx.pids.A}`, { keys: [{ t: '1' }], expect: '1. ZZZ' })).json().error).toBe("le dialogue a changé : « 1. ZZZ » n'est plus à l'écran");
      expect((await post(s, `/api/keys?pid=${fx.pids.D}`, { keys: [{ k: 'Delete' }] })).json().error).toBe('touche inconnue');
      expect((await post(s, `/api/keys?pid=${fx.pids.D}`, { keys: [{ t: '\u0007' }] })).json().error).toBe('rien à envoyer');
      expect((await post(s, `/api/keys?pid=${fx.pids.D}`, { keys: Array(21).fill({ k: 'Up' }) })).json().error).toBe('trop de touches ou texte trop long');
      expect((await post(s, `/api/keys?pid=${fx.pids.D}`, 'null')).code).toBe(400);
      await sleep(200); expect(d.keys().length).toBe(before);
    });
  });

  describe('automates, fermeture, relance', () => {
    test('automate (claude -p) : onglet, réponse, touches, fermeture, relance ⇒ 409, rien de tapé', async () => {
      const g = fx.consoles.G!;
      for (const p of ['focus', 'send', 'keys', 'close', 'relaunch']) {
        const r = await post(s, `/api/${p}?pid=${fx.pids.G}`, { text: 'x', keys: [{ t: 'x' }] });
        expect(r.code, p).toBe(409); expect(r.json().error).toMatch(/^automate/);
      }
      expect(g.keys()).toEqual([]);
    });
    test('fermeture groupée : règle « peut se fermer » revérifiée (sans état git ⇒ sautée), rien de fermé', async () => {
      const r = (await post(s, '/api/close-many', { pids: [fx.pids.A, 4000001] })).json();
      expect(r).toEqual({ closed: [], skipped: [{ title: 'Titre choisi pour A', why: 'ne peut plus se fermer (état changé)' }] });
    });
    test('fermeture : session au travail ⇒ confirmation demandée ; invite non vide ⇒ confirmation', async () => {
      expect((await post(s, `/api/close?pid=${fx.pids.F}`)).json()).toEqual({ error: 'la session travaille (statut busy)', needForce: true });
      expect((await post(s, `/api/close?pid=${fx.pids.C}`)).json()).toEqual({ error: "l'invite de la session n'est pas vide (brouillon, menu ou dialogue ouvert)", needForce: true });
    });
    test('fermeture d\'une session inactive : /exit tapé, puis arrêt du process (fiche retirée, journalisée)', async () => {
      const t = await TestConsole.open('empty', { exe: join(fx.root, 'bin', 'claude.exe'), ttl: 300 });
      const sid = `12345678-0000-4000-8000-00000000${kind === 'ps' ? '0ps1' : '0nd1'}`.replace(/[^0-9a-f-]/g, '0');
      writeFileSync(join(fx.claude, 'sessions', `${t.pid}.json`), JSON.stringify({ pid: t.pid, sessionId: sid, cwd: fx.work, status: 'idle', statusUpdatedAt: Date.now() - 60000, entrypoint: 'cli' }));
      const r = (await post(s, `/api/close?pid=${t.pid}`, undefined, { timeoutMs: 30000 })).json();
      expect(r).toEqual({ error: null, forced: true });       // la console de test ne sort pas sur /exit : arrêt au bout de 10 s
      expect(t.typed()).toBe('/exit\r');
      expect(existsSync(join(fx.claude, 'sessions', `${t.pid}.json`))).toBe(false);
      expect(sentLog().at(-1)).toMatchObject({ pid: t.pid, forced: true, text: '(fermeture)' });
      t.close();
    }, 40000);
  });

  describe('favoris, masquées, vu, redémarrage', () => {
    test('favori : ajouté puis retiré (fichier et état)', async () => {
      expect((await post(s, `/api/fav?id=${fx.ids.B}&on=1`)).body).toBe('{"ok":true}');
      await waitState(s, (st) => st.favs.includes(fx.ids.B));
      expect(JSON.parse(readFileSync(join(fx.claude, 'state', 'sessions-dashboard-favs.json'), 'utf8').replace(/^\uFEFF/, ''))).toContain(fx.ids.B);
      await post(s, `/api/fav?id=${fx.ids.B}&on=0`);
      await waitState(s, (st) => !st.favs.includes(fx.ids.B));
      expect((await post(s, '/api/fav?id=pas-un-id&on=1')).code).toBe(200);
    });
    test('tags corrigés à la main : ajout, retrait d’un tag automatique, refus nommés, fichier', async () => {
      const tagsOf = async (id: string) => { const st = await waitState(s, (x) => x); return (st.sessions.find((x: any) => x.sessionId === id))?.tags; };
      expect((await post(s, '/api/tags', { id: fx.ids.B, axis: 'outil', v: 'infra', on: true })).json()).toEqual({ tags: [{ axis: 'outil', v: 'infra', src: 'manuel' }] });
      expect((await post(s, '/api/tags', { id: fx.ids.B, axis: 'outil', v: 'infra', on: true })).json()).toEqual({ tags: [{ axis: 'outil', v: 'infra', src: 'manuel' }] });
      expect(await tagsOf(fx.ids.B)).toEqual([{ axis: 'outil', v: 'infra', src: 'manuel' }]);
      expect(JSON.parse(readFileSync(join(fx.claude, 'state', 'sessions-dashboard-tags-manual.json'), 'utf8').replace(/^﻿/, ''))[fx.ids.B]).toEqual({ add: [{ axis: 'outil', v: 'infra' }], remove: [] });
      expect((await post(s, '/api/tags', { id: fx.ids.B, axis: 'outil', v: 'infra', on: false })).json()).toEqual({ tags: null });
      // Retirer son propre ajout ne laisse rien : pas de « retiré » qui masquerait une future proposition automatique.
      expect(JSON.parse(readFileSync(join(fx.claude, 'state', 'sessions-dashboard-tags-manual.json'), 'utf8').replace(/^﻿/, ''))[fx.ids.B]).toBeUndefined();
      // Ajouter un tag déjà proposé automatiquement n'inscrit rien non plus.
      expect((await post(s, '/api/tags', { id: fx.ids.H, axis: 'domaine', v: 'Compta', on: true })).json()).toEqual({ tags: [{ axis: 'domaine', v: 'Compta', src: 'fichiers' }] });
      expect(JSON.parse(readFileSync(join(fx.claude, 'state', 'sessions-dashboard-tags-manual.json'), 'utf8').replace(/^﻿/, ''))[fx.ids.H]).toBeUndefined();
      // Un tag automatique retiré reste retiré ; le remettre annule le retrait.
      const r = (await post(s, '/api/tags', { id: fx.ids.A, axis: 'domaine', v: 'Téléphonie', on: false })).json();
      expect(r.tags.some((t: any) => t.axis === 'domaine')).toBe(false);
      expect((await post(s, '/api/tags', { id: fx.ids.A, axis: 'domaine', v: 'Téléphonie', on: true })).json().tags).toContainEqual({ axis: 'domaine', v: 'Téléphonie', src: 'hd' });
      const err = async (b: unknown) => { const x = await post(s, '/api/tags', b); return [x.code, x.body ? JSON.parse(x.body) : null]; };
      expect(await err({ id: 'pas-un-id', axis: 'outil', v: 'infra', on: true })).toEqual([400, { error: 'session inconnue' }]);
      expect(await err({ id: fx.ids.B, axis: 'hd', v: 'HD-1', on: true })).toEqual([400, { error: 'axe non modifiable (domaine, outil ou fonction)' }]);
      expect(await err({ id: fx.ids.B, axis: 'domaine', v: 'Inventé', on: true })).toEqual([400, { error: 'domaine hors liste' }]);
      expect(await err({ id: fx.ids.B, axis: 'outil', v: 'Autre', on: true })).toEqual([400, { error: 'outil hors liste' }]);
      expect(await err({ id: fx.ids.B, axis: 'fonction', v: 'Power Dial', on: true })).toEqual([400, { error: 'fonction : 1 à 5 mots en minuscules reliés par « - », 3 à 40 caractères' }]);
      expect(await err({ id: fx.ids.B, axis: 'fonction', v: 3, on: true })).toEqual([400, {}]);
      expect((await post(s, '/api/tags', 'null')).code).toBe(400);
      const vocab = (await call(s, '/api/tag-vocab')).json();
      expect(vocab.domaines).toContain('Téléphonie'); expect(vocab.domaines).not.toContain('Autre'); expect(vocab.outils).toContain('infra');
    });
    test('masquer / ré-afficher : nombre de changements', async () => {
      expect((await post(s, '/api/hide', { ids: [fx.ids.H, 'pas-un-id'], on: true })).json()).toEqual({ changed: 1 });
      expect((await post(s, '/api/hide', { ids: [fx.ids.H], on: true })).json()).toEqual({ changed: 0 });
      expect((await post(s, '/api/hide', { ids: [fx.ids.H], on: false })).json()).toEqual({ changed: 1 });
      expect((await post(s, '/api/hide', 'null')).code).toBe(400);
    });
    test('ack : la session n\'est plus « à relire »', async () => {
      await post(s, `/api/ack?pid=${fx.pids.E}`);
      await waitState(s, (st) => st.sessions.find((x: any) => x.sessionId === fx.ids.E && !x.done));
    });
    test('réouverture groupée : identifiants invalides ou déjà ouverts ⇒ rien d\'ouvert ; réouverture : refus explicites', async () => {
      expect((await post(s, '/api/reopen-many', { ids: ['pas-un-id', fx.ids.A, '00000000-0000-0000-0000-000000000000'] })).json()).toEqual({ error: 'aucune session à rouvrir', opened: 0, skipped: 3 });
      expect((await post(s, '/api/reopen-many', {})).json()).toEqual({ error: 'aucune session à rouvrir', opened: 0, skipped: 0 });
      expect((await post(s, '/api/reopen?id=x')).json()).toEqual({ error: 'identifiant invalide' });
      expect((await post(s, `/api/reopen?id=${fx.ids.A}`)).json()).toEqual({ error: 'session déjà ouverte' });
      expect((await post(s, '/api/reopen?id=00000000-0000-4000-8000-000000000000')).json()).toEqual({ error: 'transcript introuvable' });
    });
    test('dossier dont le chemin contient « ; » : réouverture refusée (Windows Terminal y couperait la commande), rien d\'ouvert', async () => {
      expect(fx.semiDir).toContain(';');
      expect((await post(s, `/api/reopen?id=${fx.ids.L}`)).json()).toEqual({ error: 'dossier refusé : son chemin contient « ; », que Windows Terminal lirait comme une seconde commande' });
      expect((await post(s, '/api/reopen-many', { ids: [fx.ids.L] })).json()).toEqual({ error: 'aucune session à rouvrir', opened: 0, skipped: 1 });
    });
    test('Ignorer le redémarrage : plus rien de proposé', async () => {
      expect((await post(s, '/api/reboot-dismiss')).body).toBe('{"ok":true}');
      await waitState(s, (st) => st.reboot === null);
    });
  });

  describe('nouvelle session (aucun onglet ouvert)', () => {
    const nb = async (o: Record<string, unknown>): Promise<string> => (await post(s, '/api/new', { cwd: fx.work, prompt: '', model: '', branch: '', ...o })).json().error;
    test('refus : dossier non proposé, modèle invalide, message trop long, branche invalide, hors dépôt git, branche existante', async () => {
      expect(await nb({ cwd: 'C:\\Windows' })).toBe('dossier non proposé');
      expect(await nb({ model: 'opus; rm' })).toBe('modèle invalide');
      expect(await nb({ prompt: 'p'.repeat(20001) })).toBe('premier message trop long');
      expect(await nb({ branch: 'Feat/../x' })).toMatch(/^nom de branche invalide/);
      expect(await nb({ cwd: join(fx.work, '..', 'autre'), branch: 'feat/x' })).toBe("ce dossier n'est pas dans un dépôt git");
      expect(await nb({ branch: 'feat/essai' })).toBe('la branche feat/essai existe déjà');
    });
    test('à partir d\'une autre session : identifiant invalide, transcript inconnu', async () => {
      expect(await nb({ forkFrom: 'x; calc' })).toBe('session source : identifiant invalide');
      expect(await nb({ forkFrom: '00000000-0000-0000-0000-000000000000' })).toBe('session source : transcript introuvable');
      expect(await nb({ sessionId: 'x; calc' })).toBe('identifiant de session invalide');
    });
    test('tags choisis : refusés avant tout onglet (liste, nombre, axe, listes fermées, forme)', async () => {
      expect(await nb({ tags: 'x' })).toBe('tags : liste attendue');
      expect(await nb({ tags: Array.from({ length: 9 }, (_, i) => ({ axis: 'fonction', v: 'fn-' + i })) })).toBe('tags : 8 au plus');
      expect(await nb({ tags: [{ axis: 'hd', v: 'HD-555555' }] })).toBe('tag hd:HD-555555 : axe non modifiable (domaine, outil ou fonction)');
      expect(await nb({ tags: [{ axis: 'domaine', v: 'Téléphonie' }, { axis: 'domaine', v: 'Inexistant' }] })).toBe('tag domaine:Inexistant : domaine hors liste');
      expect(await nb({ tags: [{ axis: 'outil', v: 'Contact-Center' }] })).toBe('tag outil:Contact-Center : outil hors liste');
      expect(await nb({ tags: [{ axis: 'fonction', v: 'Power Dial' }] })).toBe('tag fonction:Power Dial : fonction : 1 à 5 mots en minuscules reliés par « - », 3 à 40 caractères');
    });
  });

  describe('pièces jointes', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(Array.from({ length: 200 }, (_, i) => i % 256))]);
    const up = (name: string | null, body: Buffer, type = 'image/png', origin: string | null = s.base, headers: Record<string, string> = {}) =>
      call(s, '/api/upload', { method: 'POST', origin, body, headers: { 'content-type': type, ...(name !== null ? { 'x-file-name': encodeURIComponent(name) } : {}), ...headers } });
    test('écrite sous uploads-<port>\\<jour>\\<id>-<nom nettoyé>, octets identiques ; sans nom ⇒ capture.png', async () => {
      const r = await up("Capture d'écran 2026-11-17.png", png); expect(r.code).toBe(200);
      const p = r.json().path as string;
      expect(p.toLowerCase().startsWith(join(fx.claude, `uploads-${s.port}`).toLowerCase() + '\\')).toBe(true);
      expect(p).toMatch(/\\\d{4}-\d{2}-\d{2}\\[0-9a-f]{8}-Capture_d_ecran_2026-11-17\.png$/);
      expect(readFileSync(p).equals(png)).toBe(true);
      expect((await up(null, png)).json().path).toMatch(/-capture\.png$/);
    });
    test('noms piégés restent dans uploads ; types refusés ⇒ 415 ; vide ⇒ 400 ; > 20 Mo ⇒ 413', async () => {
      for (const n of ['..\\..\\..\\settings.json', '../../evil.md', 'C:\\Windows\\win.ini.txt', '....png']) {
        const r = await up(n, Buffer.from('{}'), 'application/json');
        if (r.code === 200) { const p = r.json().path as string; expect(p.toLowerCase().startsWith(join(fx.claude, `uploads-${s.port}`).toLowerCase())).toBe(true); expect(p.split('\\').at(-1)).not.toContain('..'); }
      }
      for (const [n, t] of [['a.zip', 'application/zip'], ['a.exe', 'application/octet-stream'], ['a.html', 'text/html'], ['sans-extension', 'application/octet-stream']]) expect((await up(n!, png, t)).code, n).toBe(415);
      expect((await up('vide.png', Buffer.alloc(0))).code).toBe(400);
      expect((await up('gros.png', Buffer.alloc(20 * 1024 * 1024 + 1))).code).toBe(413);
    });
    test('sans Origin, autre site, GET, à distance hors propriétaire ⇒ 403', async () => {
      expect((await up('x.png', png, 'image/png', null)).code).toBe(403);
      expect((await up('x.png', png, 'image/png', 'http://evil.example')).code).toBe(403);
      expect((await call(s, '/api/upload')).code).toBe(403);
      expect((await up('x.png', png, 'image/png', s.base, { 'x-forwarded-for': '100.64.0.9', 'tailscale-user-login': 'autre@example.com' })).code).toBe(403);
      expect((await call(s, '/api/upload', { method: 'POST', port: s.port + 1, host: 'x.ts.net', origin: s.base, body: png })).code).toBe(403);
      expect((await call(s, '/api/upload', { method: 'POST', port: s.port + 1, host: TS_HOST, origin: s.base, body: png })).code).toBe(403);
    });
    test('à distance : acceptée pour le propriétaire depuis la page du tailnet, refusée d\'un autre site', async () => {
      const owner = { 'x-forwarded-for': '100.64.0.9', 'tailscale-user-login': TS_OWNER };
      const ok = await up('tel.png', png, 'image/png', TS_ORIGIN, owner);
      expect(ok.code).toBe(200); expect(readFileSync(ok.json().path).equals(png)).toBe(true);
      expect((await up('tel.png', png, 'image/png', 'https://evil.example', owner)).code).toBe(403);
      expect((await up('tel.png', png, 'image/png', TS_ORIGIN, { ...owner, 'sec-fetch-site': 'cross-site' })).code).toBe(403);
    });
  });

  describe('hook « Stop »', () => {
    test('depuis un navigateur (Origin) ⇒ 403 ; Stop ⇒ 200 corps vide, visible dans l\'état ; sous-agent ignoré', async () => {
      expect((await post(s, '/api/hook', '{}')).code).toBe(403);
      const r = await call(s, '/api/hook', { method: 'POST', body: JSON.stringify({ session_id: fx.ids.A, hook_event_name: 'Stop', stop_hook_active: false }) });
      expect(r.code).toBe(200); expect(r.body).toBe('');
      await waitState(s, (st) => st.sessions.find((x: any) => x.sessionId === fx.ids.A)?.hookStop > 0);
      await call(s, '/api/hook', { method: 'POST', body: JSON.stringify({ session_id: fx.ids.B, hook_event_name: 'Stop', agent_id: 'a1' }) });
      await sleep(1500);
      expect((await call(s, '/api/state')).json().sessions.find((x: any) => x.sessionId === fx.ids.B).hookStop).toBe(0);
    });
  });

  describe('accès distant', () => {
    // Le profil de test a un faux tailscale.exe : propriétaire TS_OWNER, poste TS_HOST (harness.ts).
    const remote = (m: string, p: string, o: string | null, login: string | null = TS_OWNER, extra: Record<string, string> = {}) =>
      call(s, p, { method: m, origin: o, headers: { 'x-forwarded-for': '100.64.0.9', ...(login === null ? {} : { 'tailscale-user-login': login }), ...extra }, ...(m === 'POST' ? { body: '{}' } : {}) });
    const reads = (): string[] => ['/', '/app.js', '/api/state', '/api/closed', `/api/screen?pid=${fx.pids.A}`, `/api/transcript?id=${fx.ids.A}`, '/api/find?q=coffre', '/api/ping'];
    const OWNER_ONLY = { error: 'accès distant réservé au propriétaire du poste' };
    test('propriétaire : lecture ; écriture depuis la page du tailnet seulement ; hook et arrêt jamais', async () => {
      for (const p of reads()) expect((await remote('GET', p, null)).code, p).toBe(200);
      expect((await remote('GET', '/api/whoami', null)).json()).toEqual({ remote: true, write: true, login: TS_OWNER });
      expect((await remote('POST', '/api/send-many', TS_ORIGIN)).json()).toEqual({ results: [] });
      for (const o of [s.base, 'https://evil.example', null]) expect((await remote('POST', '/api/send-many', o)).json(), String(o)).toEqual({ error: 'action refusée à distance' });
      expect((await remote('POST', '/api/hook', null)).code).toBe(403);
      expect((await remote('GET', '/api/stop', null)).code).toBe(403);
      expect((await remote('POST', '/api/stop', TS_ORIGIN)).code).toBe(403);
      expect((await call(s, '/api/ping')).code).toBe(200);
    });
    test('autre membre du tailnet, ou sans identité : rien, ni lecture ni écriture', async () => {
      for (const login of ['autre@example.com', `x${TS_OWNER}`, '', null]) {
        for (const p of reads()) { const r = await remote('GET', p, null, login); expect(r.code, `${login} ${p}`).toBe(403); expect(r.json()).toEqual(OWNER_ONLY); }
        expect((await remote('POST', '/api/send-many', TS_ORIGIN, login)).json()).toEqual(OWNER_ONLY);
      }
      expect((await remote('GET', '/api/whoami', null, 'autre@example.com')).json()).toEqual({ remote: true, write: false, login: 'autre@example.com' });
    });
    test('relais : seul le nom du poste sur le tailnet est transmis (DNS rebinding ⇒ 403), et toujours comme une requête distante', async () => {
      const via = (p: string, host: string, login: string | null = TS_OWNER, o: Parameters<typeof call>[2] = {}) =>
        call(s, p, { port: s.port + 1, host, headers: login === null ? {} : { 'tailscale-user-login': login }, ...o });
      const REFUSED = { error: 'hôte refusé par le relais' };
      // Le nom d'un autre site, un nom qui ressemble, localhost, l'adresse : refusés, même avec l'en-tête du propriétaire.
      for (const host of ['evil.example', `${TS_HOST}.evil.example`, `evil.${TS_HOST}`, 'x.ts.net', `localhost:${s.port + 1}`, `127.0.0.1:${s.port + 1}`, `localhost:${s.port}`]) {
        for (const p of ['/', '/api/state', '/api/whoami', `/api/transcript?id=${fx.ids.A}`, `/api/screen?pid=${fx.pids.A}`]) {
          const r = await via(p, host); expect(r.code, `${host} ${p}`).toBe(403); expect(r.json()).toEqual(REFUSED);
        }
        expect((await via('/api/send-many', host, TS_OWNER, { method: 'POST', origin: TS_ORIGIN, body: '{"pids":[1],"text":"x"}' })).json()).toEqual(REFUSED);
      }
      // Le nom du poste (sans la casse, avec ou sans port) : transmis, propriétaire servi.
      for (const host of [TS_HOST, TS_HOST.toUpperCase(), `${TS_HOST}:443`]) {
        const r = await via('/api/state', host); expect(r.code, host).toBe(200); expect(r.json().sessions).toBeDefined();
      }
      expect((await via('/api/whoami', TS_HOST)).json()).toEqual({ remote: true, write: true, login: TS_OWNER });
      expect((await via('/api/send-many', TS_HOST, TS_OWNER, { method: 'POST', origin: TS_ORIGIN, body: '{}' })).json()).toEqual({ results: [] });
      // Transmis sans identité Tailscale : traité comme DISTANT (jamais comme une requête du poste), donc refusé.
      expect((await via('/api/whoami', TS_HOST, null)).json()).toEqual({ remote: true, write: false, login: '' });
      for (const p of ['/', '/api/state', `/api/screen?pid=${fx.pids.A}`]) expect((await via(p, TS_HOST, null)).json(), p).toEqual(OWNER_ONLY);
      expect((await via('/api/state', TS_HOST, 'autre@example.com')).json()).toEqual(OWNER_ONLY);
      expect((await via('/api/stop', TS_HOST)).code).toBe(403);
      expect((await call(s, '/api/ping')).code).toBe(200);
    });
    test('requête venue d\'un autre site (Sec-Fetch-Site) : jamais l\'API, la page reste ouvrable', async () => {
      const from = (v: string, p: string, o: Parameters<typeof call>[2] = {}) => call(s, p, { ...o, headers: { 'sec-fetch-site': v } });
      const OTHER_SITE = { error: "requête venue d'un autre site" };
      for (const v of ['cross-site', 'same-site', 'Cross-Site']) {
        for (const p of ['/api/stop', '/api/state', '/api/whoami', '/api/ping', `/api/screen?pid=${fx.pids.A}`, '/api/nexistepas']) {
          const r = await from(v, p); expect(r.code, `${v} ${p}`).toBe(403); expect(r.json()).toEqual(OTHER_SITE);
        }
        expect((await from(v, `/api/fav?id=${fx.ids.B}&on=1`, { method: 'POST', origin: s.base, body: '' })).json()).toEqual(OTHER_SITE);
        expect((await from(v, '/api/hook', { method: 'POST', body: JSON.stringify({ session_id: fx.ids.C, hook_event_name: 'Stop' }) })).json()).toEqual(OTHER_SITE);
        for (const p of ['/', '/app.js', '/app.css']) expect((await from(v, p)).code, `${v} ${p}`).toBe(200);
      }
      for (const v of ['same-origin', 'none']) {
        expect((await from(v, '/api/state')).code, v).toBe(200);
        expect((await from(v, '/api/reboot-dismiss', { method: 'POST', origin: s.base, body: '' })).body).toBe('{"ok":true}');
      }
      // Rien n'a été exécuté : le serveur tourne, B n'est pas devenue favorite.
      expect((await call(s, '/api/ping')).code).toBe(200);
      expect((await call(s, '/api/state')).json().favs ?? []).not.toContain(fx.ids.B);
    });
  });

  describe('corps de requête plafonné', () => {
    const TOO_BIG = { error: 'corps de requête trop gros (1 Mo au plus)' };
    test('plus de 1 Mo annoncé ⇒ 413 sans rien exécuter ; juste en dessous ⇒ traité', async () => {
      const big = JSON.stringify({ ids: [fx.ids.H], on: true, pad: 'x'.repeat(1024 * 1024) });
      // Le serveur répond 413 puis coupe sans attendre la fin du corps : selon l'instant, le client lit le 413 ou voit
      // la coupure pendant qu'il écrit encore — jamais un 200.
      const refused = async (path: string): Promise<void> => {
        let r: Awaited<ReturnType<typeof call>> | null = null;
        try { r = await call(s, path, { method: 'POST', body: big, origin: s.base }); } catch { /* coupé pendant l'écriture */ }
        if (r) { expect(r.code).toBe(413); expect(r.json()).toEqual(TOO_BIG); }
      };
      await refused('/api/hide'); await refused('/api/hook'); await refused('/api/new');
      const ok = await post(s, '/api/hide', JSON.stringify({ ids: [], on: true, pad: 'x'.repeat(1024 * 1024 - 200) })); expect(ok.code).toBe(200);
      expect(ok.json()).toEqual({ changed: 0 });
      expect(JSON.parse(readFileSync(join(fx.claude, 'state', 'sessions-dashboard-hidden.json'), 'utf8').replace(/^﻿/, ''))).not.toContain(fx.ids.H);
    });
    test('sans longueur annoncée (chunked) : lu en flux, coupé au-delà de 1 Mo', async () => {
      const chunked = (path: string, body: Buffer): Promise<{ code: number | 'coupé'; body: string }> => new Promise((ok) => {
        const rq = request({ host: '127.0.0.1', port: s.port, path, method: 'POST', headers: { host: `localhost:${s.port}`, origin: s.base, 'content-type': 'application/json' }, timeout: 30000 }, (res) => {
          const parts: Buffer[] = []; res.on('data', (c: Buffer) => parts.push(c));
          res.on('end', () => ok({ code: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8') })); res.on('error', () => ok({ code: 'coupé', body: '' }));
        });
        rq.on('timeout', () => rq.destroy()); rq.on('error', () => ok({ code: 'coupé', body: '' }));
        for (let i = 0; i < body.length; i += 65536) rq.write(body.subarray(i, i + 65536));
        rq.end();
      });
      const small = await chunked('/api/hide', Buffer.from('{"ids":[],"on":true}'));
      expect(small).toEqual({ code: 200, body: '{"changed":0}' });
      // Le serveur répond 413 puis coupe : selon l'instant, le client lit le 413 ou voit la coupure — jamais un 200.
      const r = await chunked('/api/hide', Buffer.from(JSON.stringify({ ids: [fx.ids.H], on: true, pad: 'x'.repeat(1024 * 1024 + 70000) })));
      expect([413, 'coupé']).toContain(r.code);
      if (r.code === 413) expect(JSON.parse(r.body)).toEqual(TOO_BIG);
      expect((await call(s, '/api/ping')).code).toBe(200);
      expect(JSON.parse(readFileSync(join(fx.claude, 'state', 'sessions-dashboard-hidden.json'), 'utf8').replace(/^﻿/, ''))).not.toContain(fx.ids.H);
    });
  });

  describe('lanceur', () => {
    test('vue : runs des 48 h (le plus récent d\'abord), fichiers triés, titres, états, attentes, erreurs, coût', async () => {
      const l = (await call(s, '/api/launcher')).json();
      expect(l.present).toBe(true); expect(l.hours).toBe(48);
      expect(l.runs.map((r: any) => r.dir)).toEqual([fx.runDirs.other, fx.runDirs.dev, fx.runDirs.diag].map((d) => d!.split('\\runs\\')[1]));
      const diag = l.runs.find((r: any) => r.phase === 'diagnostic' && r.hd === '111');
      expect(diag.files.map((f: any) => f.name)).toEqual(['result.md', 'review.md', 'note.html', 'Capture.png']);
      expect(diag).toMatchObject({ title: 'fix(x): le titre de la PR de 111', outcome: 'failed', costUsd: 1.005, turns: 29, sessionId: '3c7e46be-17d0-48d6-b2c9-e5c3b238b0ef', stage: 'dev-failed', running: false });
      expect(l.runs.find((r: any) => r.phase === 'dev')).toMatchObject({ outcome: 'success', minutes: 12 });
      expect(l.runs.find((r: any) => r.hd === '222')).toMatchObject({ title: 'Titre de 222', outcome: 'running', sessionId: '12345678-1234-1234-1234-123456789abc' });
      expect(l.waiting.map((w: any) => [w.hd, w.since])).toEqual([['222', Date.UTC(2026, 10, 18, 9, 30)], ['111', Date.UTC(2026, 10, 18, 9)]]);
      expect(l.errors).toEqual([{ kind: 'lastWait', message: 'disque C: presque plein', at: 1794588312080 }, { kind: 'lastPassError', message: 'TimeoutExpired', at: 1794588000500 }]);
      expect(l.cost).toBe(3.5); expect(l.heartbeat).toBe(Math.floor((fx.t0 - 50 * 60000) / 1000) * 1000);
      expect((await call(s, '/api/launcher?hours=168')).json().runs).toHaveLength(4);
    });
    test('fichier : texte brut (jamais HTML), nosniff ; image ; hors runs\\ ⇒ 404 ; extension refusée ⇒ 403', async () => {
      const rel = fx.runDirs.diag!.split('\\runs\\')[1]!;
      const r = await call(s, `/api/launcher/file?path=${encodeURIComponent(rel + '\\note.html')}`);
      expect(r.code).toBe(200); expect(r.headers['content-type']).toBe('text/plain; charset=utf-8'); expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect((await call(s, `/api/launcher/file?path=${encodeURIComponent(rel + '\\Capture.png')}`)).headers['content-type']).toBe('image/png');
      expect((await call(s, `/api/launcher/file?path=${encodeURIComponent('..\\state.json')}`)).code).toBe(404);
      expect((await call(s, `/api/launcher/file?path=${encodeURIComponent('C:\\Windows\\win.ini')}`)).code).toBe(404);
      expect((await call(s, `/api/launcher/file?path=${encodeURIComponent(rel + '\\secret.exe')}`)).code).toBe(403);
    });
    test('fichier : les noms que la liste masque (settings.json, mcp.json) ne se lisent pas non plus ⇒ 403', async () => {
      const rel = fx.runDirs.diag!.split('\\runs\\')[1]!;
      const listed = (await call(s, '/api/launcher')).json().runs.flatMap((r: any) => r.files.map((f: any) => f.name.toLowerCase()));
      for (const n of ['settings.json', 'mcp.json', 'SETTINGS.JSON', 'Mcp.Json', 'x\\..\\settings.json']) {
        expect(listed).not.toContain(n.toLowerCase());
        const r = await call(s, `/api/launcher/file?path=${encodeURIComponent(rel + '\\' + n)}`);
        expect(r.code, n).toBe(403); expect(r.body).toBe('{}');
      }
    });
    test('alertes (sans rien envoyer) : arrêt, run en échec, dev en échec, quota > 90 %, demande qui t’attend', async () => {
      const a = (await call(s, '/api/test-launcher-alerts')).json().alerts;
      const keys = a.map((x: any) => x.key).sort();
      const held = Math.floor((fx.t0 - 10 * 60000) / 1000) * 1000;
      expect(keys).toEqual(['down', `quota:a@exemple.fr:${usPs(new Date(fx.t0 + 86400000))}`, `quota:a@exemple.fr:Opus:${usPs(new Date(fx.t0 + 86400000))}`, `run:${fx.runDirs.diag!.toLowerCase()}`, `stage:111:${Date.UTC(2026, 10, 18, 9)}`,
        `wait:444:diagnosis-held:${held}`].sort());
      expect(a.find((x: any) => x.key.startsWith('wait:'))).toMatchObject({ hd: '444', title: "Lanceur : HD-444 t'attend — diagnostic posé, go attendu", text: 'diagnostic posé, aucun correctif lancé' });
      expect(a.find((x: any) => x.key === 'down').text).toMatch(/^Aucun signe de vie depuis 5\d min(, aucun run en cours| \(un run tourne pourtant\)) — /);
      expect(a.find((x: any) => x.key.startsWith('run:'))).toMatchObject({ title: 'Lanceur : diagnostic en échec — HD-111', text: 'failed — écriture refusée' });
      expect(a.find((x: any) => x.key.startsWith('quota:')).title).toBe('Quota Claude à 92 % — a@exemple.fr');
      // La limite propre à un modèle alerte à part (Opus 95 %) ; sous 90 % (Fable 43 %) elle se tait.
      expect(a.find((x: any) => x.key.startsWith('quota:a@exemple.fr:Opus:'))).toMatchObject({ title: 'Quota Claude Opus à 95 % — a@exemple.fr' });
    });
  });

  describe('recherche', () => {
    test('mots dans un même message, sans casse ni accents ; extraits du plus récent', async () => {
      const r = (await call(s, '/api/find?q=COFFRE%20partag%C3%A9')).json();
      expect(r).toMatchObject({ q: 'COFFRE partagé', indexed: 1, total: 1, sessions: 1 });
      expect(r.hits[0]).toMatchObject({ sessionId: fx.ids.H, title: 'Session fermée H', count: 1, snippets: [{ role: 'user', text: 'Où est le coffre Vaultwarden partagé ?' }] });
      expect((await call(s, '/api/find?q=x')).json()).toEqual({ q: 'x', indexed: 1, indexing: false, hits: [], total: 0, ms: 0 });
    });
  });

  describe('boucle occupée, arrêt', () => {
    test('boucle occupée 3 s : état, ping et écran répondent quand même', async () => {
      const busy = call(s, '/api/test-busy?ms=3000');
      await sleep(300);
      let slow = 0;
      for (let i = 0; i < 5; i++) { const t = Date.now(); await call(s, '/api/state'); await call(s, '/api/ping'); await call(s, `/api/screen?pid=${fx.pids.A}`); slow = Math.max(slow, Date.now() - t); await sleep(200); }
      expect(slow).toBeLessThan(1000);
      expect((await busy).code).toBe(200);
    });
    test('aucune route n\'a levé d\'exception, rien sur stderr', () => {
      const log = join(fx.claude, 'state', `sessions-dashboard-errors-${s.port}.log`);
      const lines = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.trim() && !/écriture à distance désactivée/.test(l)) : [];
      expect(lines).toEqual([]);
      expect(s.stderr.trim()).toBe('');
    });
    test('arrêt propre (/api/stop)', async () => {
      expect((await call(s, '/api/stop')).body).toBe('{"stopped":true}');
      for (let i = 0; i < 100 && s.proc.exitCode === null; i++) await sleep(100);
      expect(s.proc.exitCode).not.toBeNull();
    });
  });
  void readdirSync;
});

/** « "$date" » de PowerShell pour une date ISO en Z : MM/dd/yyyy HH:mm:ss en UTC. */
function usPs(d: Date): string { const p = (n: number): string => String(n).padStart(2, '0'); return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`; }
void DIALOG;
