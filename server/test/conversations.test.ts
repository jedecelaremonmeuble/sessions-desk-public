// Vue par conversation (teams-watcher.ts) : tous les chats actifs, « à toi de répondre », « à voir », pointage « Vu ».
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  conversationCounts, conversationRows, conversationsView, conversationThread, convFromPreview, convMsgFrom, convThread, defaultConfig, defaultConversations, htmlLines, loginScope, markConversationSeen,
  mentionsOwner, replyHtml, runConversations, saveWait, sendChatReply, setOwner, writeSummary,
  type ConvChat, type ConvMsg, type ConvState, type GraphMessage, type InboundState, type Wait,
} from '../src/teams-watcher.ts';

const ME = 'me-id', OTHER = 'other-id';
const T0 = Date.UTC(2026, 10, 20, 10, 0), MIN = 60_000, DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
const preview = (o: Record<string, unknown> = {}) => ({ id: '1001', createdDateTime: iso(T0), messageType: 'message', body: { contentType: 'html', content: '<p>Tu peux regarder la facture ?</p>' }, from: { user: { id: OTHER, displayName: 'Camille MARTIN' } }, ...o });
const chat = (o: Partial<ConvChat> = {}): ConvChat => ({ label: 'Camille MARTIN', type: 'oneOnOne', webUrl: 'https://teams.example.com/c1', lastId: '1001', lastAt: T0, lastFrom: 'Camille MARTIN', who: 'other', excerpt: 'Tu peux regarder la facture ?', ack: false, mention: false, ...o });
const state = (chats: Record<string, ConvChat>, since = T0 - DAY): ConvState => ({ v: 1, since, at: T0 + MIN, chats });
const wait = (o: Partial<Wait> = {}): Wait => ({ v: 1, sessionId: 'sess-1', chatId: 'c1', messageId: '900', sentAt: T0 - 30 * MIN, excerpt: 'question', cwd: null, status: 'open', ...o });
const NOW = T0 + 5 * MIN;

describe('dernier message d’un chat', () => {
  beforeEach(() => setOwner('Alex Durand'));
  test('message d’un collègue : extrait, auteur ; politesse reconnue', () => {
    expect(convFromPreview(preview(), ME)).toMatchObject({ lastId: '1001', lastAt: T0, lastFrom: 'Camille MARTIN', who: 'other', excerpt: 'Tu peux regarder la facture ?', ack: false, mention: false });
    expect(convFromPreview(preview({ body: { contentType: 'html', content: '<p>Merci beaucoup !</p>' } }), ME)).toMatchObject({ ack: true });
  });
  test('le sien, une application, une image, un message supprimé', () => {
    expect(convFromPreview(preview({ from: { user: { id: ME, displayName: 'Alex Durand' } } }), ME)).toMatchObject({ who: 'me', ack: false });
    expect(convFromPreview(preview({ from: { application: { displayName: 'Robot' } } }), ME)).toMatchObject({ who: 'app', lastFrom: 'Robot' });
    expect(convFromPreview(preview({ body: { contentType: 'html', content: '<img src="x">' } }), ME)).toMatchObject({ excerpt: '(image)' });
    expect(convFromPreview(preview({ isDeleted: true }), ME)).toMatchObject({ excerpt: '(message supprimé)' });
  });
  test('rien à répondre : remerciement sans question, message supprimé ; « merci de … » et une question restent des demandes', () => {
    const ack = (content: string) => convFromPreview(preview({ body: { contentType: 'html', content } }), ME)!.ack;
    expect(ack('Hello Alex, merci beaucoup pour les accès tout fonctionne parfaitement !')).toBe(true);
    expect(ack('Ha yes dans la config, je suis allé vérifier, merci !')).toBe(true);
    expect(ack('Merci de me rappeler avant midi')).toBe(false);
    expect(ack('Merci ! Tu as des nouvelles sur les macros ?')).toBe(false);
    expect(convFromPreview(preview({ isDeleted: true }), ME)).toMatchObject({ ack: true });
    expect(convFromPreview(preview({ body: { contentType: 'html', content: '<img src="x">' } }), ME)).toMatchObject({ ack: false });
  });
  test('expéditeur mis en sourdine (compte de service qui notifie) : traité comme une application', () => {
    expect(convFromPreview(preview({ from: { user: { id: 'svc', displayName: 'Robot Tickets' } } }), ME, ['robot tickets'])).toMatchObject({ who: 'app', ack: false });
    expect(convFromPreview(preview({ from: { user: { id: ME, displayName: 'Robot Tickets' } } }), ME, ['robot tickets'])).toMatchObject({ who: 'me' });
  });
  test('un événement système ou un aperçu vide ne remplace pas le dernier vrai message', () => {
    expect(convFromPreview(preview({ messageType: 'systemEventMessage' }), ME)).toBeNull();
    expect(convFromPreview(null, ME)).toBeNull();
    expect(convFromPreview({ id: '1' }, ME)).toBeNull();
  });
  test('mention de l’utilisateur : la balise <at> porte son prénom', () => {
    expect(mentionsOwner('<p><at id="0">Alex Durand</at> tu valides ?</p>')).toBe(true);
    expect(mentionsOwner('<p><at id="0">Camille MARTIN</at> tu valides ?</p>')).toBe(false);
    expect(mentionsOwner('<p>Alex tu valides ?</p>')).toBe(false);
    expect(convFromPreview(preview({ body: { contentType: 'html', content: '<at id="0">Alex</at> ton avis ?' } }), ME)).toMatchObject({ mention: true });
  });
});

describe('lignes de la vue', () => {
  test('1:1, dernier mot au collègue, aucune session : à toi de répondre, et à voir', () => {
    const [r] = conversationRows(state({ c1: chat() }), undefined, [], undefined, NOW);
    expect(r).toMatchObject({ chatId: 'c1', by: 'other', ball: 'reply', unseen: true, sessions: [] });
  });
  test('politesse : rien à répondre, mais à voir ; groupe : à répondre seulement si mentionné', () => {
    expect(conversationRows(state({ c1: chat({ ack: true }) }), undefined, [], undefined, NOW)[0]).toMatchObject({ ball: null, unseen: true });
    expect(conversationRows(state({ c1: chat({ type: 'group' }) }), undefined, [], undefined, NOW)[0]).toMatchObject({ ball: null, unseen: true });
    expect(conversationRows(state({ c1: chat({ type: 'group', mention: true }) }), undefined, [], undefined, NOW)[0]).toMatchObject({ ball: 'reply' });
  });
  test('avant la première passe : réputé vu, mais « à toi de répondre » reste calculé', () => {
    const [r] = conversationRows(state({ c1: chat() }, T0 + MIN), undefined, [], undefined, NOW);
    expect(r).toMatchObject({ unseen: false, ball: 'reply' });
  });
  test('pointage : « Vu » éteint à voir ET à répondre ; un message plus récent les rallume', () => {
    expect(conversationRows(state({ c1: chat() }), { v: 1, chats: { c1: T0 } }, [], undefined, NOW)[0]).toMatchObject({ unseen: false, ball: null });
    expect(conversationRows(state({ c1: chat({ lastAt: T0 + MIN }) }), { v: 1, chats: { c1: T0 } }, [], undefined, NOW)[0]).toMatchObject({ unseen: true, ball: 'reply' });
  });
  test('son propre message : à jour ; celui d’une session en son nom : à voir, session liée', () => {
    expect(conversationRows(state({ c1: chat({ who: 'me', lastId: '555' }) }), undefined, [], undefined, NOW)[0]).toMatchObject({ by: 'me', unseen: false, ball: null });
    const w = wait({ messageId: '1001', sentAt: T0 });
    expect(conversationRows(state({ c1: chat({ who: 'me' }) }), undefined, [w], undefined, NOW)[0])
      .toMatchObject({ by: 'session', unseen: true, ball: 'waiting', sessions: [{ sessionId: 'sess-1', role: 'wait', at: T0 }] });
  });
  test('le collègue a répondu à une session : la session a reçu ce message', () => {
    const w = wait({ status: 'injected', replies: [{ id: '1001', at: T0, from: 'Camille MARTIN', text: 'oui', files: [] }] });
    expect(conversationRows(state({ c1: chat() }), undefined, [w], undefined, NOW)[0]).toMatchObject({ ball: 'session', unseen: true, sessions: [{ sessionId: 'sess-1', role: 'past' }] });
  });
  test('demande entrante confiée à une session : jusqu’au dernier message remis seulement', () => {
    const inb = (upTo: number): InboundState => ({ v: 1, since: 0, opened: [], chats: { c1: { handledAt: upTo, sessionId: 'sess-in', openedAt: T0 + 2 * MIN, sessionUpTo: upTo } } });
    expect(conversationRows(state({ c1: chat() }), undefined, [], inb(T0), NOW)[0]).toMatchObject({ ball: 'session', sessions: [{ sessionId: 'sess-in', role: 'inbound' }] });
    expect(conversationRows(state({ c1: chat({ lastAt: T0 + 3 * MIN }) }), undefined, [], inb(T0), NOW)[0]).toMatchObject({ ball: 'reply' });
  });
  test('une application : listée, jamais à voir ; les attentes d’email ne lient rien', () => {
    expect(conversationRows(state({ c1: chat({ who: 'app' }) }), undefined, [wait()], undefined, NOW)[0]).toMatchObject({ by: 'app', unseen: false, ball: null });
    expect(conversationRows(state({ c1: chat() }), undefined, [wait({ channel: 'mail' })], undefined, NOW)[0]!.sessions).toEqual([]);
  });
  test('ordre : à répondre, puis à voir, puis à jour — le plus récent d’abord ; hors fenêtre écarté ; compteurs', () => {
    const rows = conversationRows(state({
      ok: chat({ who: 'me', lastAt: T0 + 2 * MIN }), vu: chat({ ack: true, lastAt: T0 - MIN }), rep: chat({ lastAt: T0 - 2 * MIN }), vu2: chat({ type: 'group', lastAt: T0 }),
      vieux: chat({ lastAt: T0 - 20 * DAY }),
    }), undefined, [], undefined, NOW);
    expect(rows.map((r) => r.chatId)).toEqual(['rep', 'vu2', 'vu', 'ok']);
    expect(conversationCounts(rows, 7)).toEqual({ reply: 1, unseen: 2, total: 4, at: 7, send: false });
  });
});

describe('passe et fichiers', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-')); setOwner('Alex Durand'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = { conversations: { ...defaultConversations, enabled: true, threads: 0 } };
  const readState = () => JSON.parse(readFileSync(join(dir, '_conversations.json'), 'utf8')) as ConvState;
  function graphOf(pages: Record<string, unknown>, calls: string[] = []) {
    return async <T>(path: string): Promise<T> => {
      calls.push(path);
      const hit = Object.entries(pages).find(([k]) => path.startsWith(k));
      if (!hit) throw new Error(`Graph 404 sur ${path}`);
      return hit[1] as T;
    };
  }
  const LIST = '/me/chats?$expand=lastMessagePreview';

  test('liste les chats de la fenêtre, lit le nom une seule fois, s’arrête au premier trop ancien', async () => {
    const calls: string[] = [];
    const graph = graphOf({
      [LIST]: { value: [
        { id: 'c1', chatType: 'oneOnOne', webUrl: 'https://teams.example.com/c1', lastMessagePreview: preview() },
        { id: 'g1', chatType: 'group', topic: 'Projet facture', lastMessagePreview: preview({ id: '1000', createdDateTime: iso(T0 - MIN) }) },
        { id: 'c9', chatType: 'oneOnOne', lastMessagePreview: preview({ id: '998', createdDateTime: iso(T0 - 2 * MIN), from: { user: { id: ME, displayName: 'Alex Durand' } } }) },
        { id: 'h1', chatType: 'group', topic: 'Masqué', viewpoint: { isHidden: true }, lastMessagePreview: preview({ id: '999' }) },
        { id: 'old', chatType: 'oneOnOne', lastMessagePreview: preview({ id: '1', createdDateTime: iso(T0 - 30 * DAY) }) },
        { id: 'jamais', chatType: 'oneOnOne', lastMessagePreview: preview({ id: '2' }) },
      ] },
      '/chats/c9?$expand=members': { members: [{ userId: ME, displayName: 'Alex Durand' }, { userId: OTHER, displayName: 'Camille MARTIN' }] },
    }, calls);
    expect(await runConversations(dir, cfg, ME, graph, { dryRun: false, now: NOW })).toEqual({ listed: 3, errors: [] });
    const st = readState();
    expect(st.since).toBe(NOW);
    expect(Object.keys(st.chats)).toEqual(['c1', 'g1', 'c9']);
    // 1:1 : le nom vient du dernier message de l'autre ; si le dernier mot est le sien, des membres — lus une seule fois.
    expect(st.chats.c9).toMatchObject({ label: 'Camille MARTIN', who: 'me' });
    expect(calls.filter((c) => c.startsWith('/chats/'))).toEqual(['/chats/c9?$expand=members']);
    expect(st.chats.c1).toMatchObject({ label: 'Camille MARTIN', type: 'oneOnOne', webUrl: 'https://teams.example.com/c1', who: 'other', lastId: '1001' });
    expect(st.chats.g1).toMatchObject({ label: 'Projet facture', type: 'group' });
    // Deuxième passe : le nom est déjà connu, le départ ne bouge pas.
    calls.length = 0;
    await runConversations(dir, cfg, ME, graph, { dryRun: false, now: NOW + 2 * MIN });
    expect(calls.filter((c) => c.startsWith('/chats/'))).toEqual([]);
    expect(readState()).toMatchObject({ since: NOW, at: NOW + 2 * MIN });
  });
  test('page suivante suivie ; événement système : le dernier vrai message est gardé', async () => {
    const graph = graphOf({
      [LIST]: { value: [{ id: 'c1', chatType: 'oneOnOne', topic: 'A', lastMessagePreview: preview() }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/chats?$skiptoken=x' },
      '/me/chats?$skiptoken=x': { value: [{ id: 'c2', chatType: 'meeting', topic: 'Point hebdo', lastMessagePreview: preview({ id: '1002' }) }] },
    });
    expect((await runConversations(dir, cfg, ME, graph, { dryRun: false, now: NOW })).listed).toBe(2);
    expect(readState().chats.c2).toMatchObject({ type: 'meeting' });
    const sys = graphOf({ [LIST]: { value: [{ id: 'c1', chatType: 'oneOnOne', topic: 'A', lastMessagePreview: preview({ id: '2000', createdDateTime: iso(T0 + MIN), messageType: 'systemEventMessage' }) }] } });
    await runConversations(dir, cfg, ME, sys, { dryRun: false, now: NOW + 2 * MIN });
    expect(readState().chats.c1).toMatchObject({ lastId: '1001', lastAt: T0 });
  });
  test('Graph en échec ou passe à blanc : l’état d’avant est gardé', async () => {
    const ok = graphOf({ [LIST]: { value: [{ id: 'c1', chatType: 'oneOnOne', topic: 'A', lastMessagePreview: preview() }] } });
    await runConversations(dir, cfg, ME, ok, { dryRun: false, now: NOW });
    const res = await runConversations(dir, cfg, ME, graphOf({}), { dryRun: false, now: NOW + 2 * MIN });
    expect(res.errors).toHaveLength(1);
    expect(readState().at).toBe(NOW);
    await runConversations(dir, cfg, ME, ok, { dryRun: true, now: NOW + 4 * MIN });
    expect(readState().at).toBe(NOW);
  });

  test('vue, résumé et pointage : « Vu » porte l’heure du message affiché, « * » pointe tout, « unseen » remet à voir', () => {
    expect(conversationsView(dir, NOW)).toBeNull();
    expect(markConversationSeen(dir, 'c1', 'seen', T0, NOW)).toBe('vue par conversation éteinte');
    writeFileSync(join(dir, '_conversations.json'), JSON.stringify(state({ c1: chat(), c2: chat({ type: 'group', lastAt: T0 + MIN }), c3: chat({ lastAt: T0 + 2 * MIN }) })));
    saveWait(dir, wait({ chatId: 'c2' }));
    writeSummary(dir, NOW);
    const summary = () => JSON.parse(readFileSync(join(dir, '_summary.json'), 'utf8')) as { conversations?: unknown };
    expect(summary().conversations).toEqual({ reply: 2, unseen: 1, total: 3, at: T0 + MIN, send: false });
    expect(conversationsView(dir, NOW)!.rows.map((r) => [r.chatId, r.ball, r.unseen])).toEqual([['c3', 'reply', true], ['c1', 'reply', true], ['c2', null, true]]);

    expect(markConversationSeen(dir, 'inconnu', 'seen', T0, NOW)).toBe('conversation introuvable');
    expect(markConversationSeen(dir, 'c1', 'efface', T0, NOW)).toBe('action inconnue');
    expect(markConversationSeen(dir, 'c1', 'seen', T0, NOW)).toBeNull();
    expect(summary().conversations).toMatchObject({ reply: 1, unseen: 1 });
    // c3 affiché à T0 alors que son dernier message est plus récent : il reste à voir.
    expect(markConversationSeen(dir, 'c3', 'seen', T0, NOW)).toBeNull();
    expect(conversationsView(dir, NOW)!.rows.find((r) => r.chatId === 'c3')).toMatchObject({ ball: 'reply', unseen: true });
    expect(markConversationSeen(dir, '*', 'seen', NOW, NOW)).toBeNull();
    expect(summary().conversations).toMatchObject({ reply: 0, unseen: 0, total: 3 });
    expect(markConversationSeen(dir, 'c1', 'unseen', 0, NOW)).toBeNull();
    expect(conversationsView(dir, NOW)!.rows[0]).toMatchObject({ chatId: 'c1', ball: 'reply', unseen: true });
  });
});

// ─────────────── fil relu, messages en entier, réponse depuis la page ───────────────

const gm = (id: string, at: number, uid: string, content: string, o: Record<string, unknown> = {}): GraphMessage => ({
  id, createdDateTime: iso(at), messageType: 'message', from: { user: { id: uid, displayName: uid === ME ? 'Alex Durand' : 'Camille MARTIN' } }, body: { contentType: 'html', content }, ...o,
});
const msg = (id: string, at: number, o: Partial<ConvMsg> = {}): ConvMsg => ({ id, at, from: 'Camille MARTIN', who: 'other', text: 't', ack: false, mention: false, quotesMe: false, named: false, question: false, ...o });
const withThread = (recent: ConvMsg[], o: Partial<ConvChat> = {}): ConvChat => {
  const last = recent.at(-1)!;
  return chat({ type: 'group', lastId: last.id, lastAt: last.at, who: last.who, recent, recentFor: last.id, ...o });
};
const row1 = (c: ConvChat, seen?: number, waits: Wait[] = []) => conversationRows(state({ c1: c }), seen === undefined ? undefined : { v: 1, chats: { c1: seen } }, waits, undefined, NOW)[0]!;

describe('un message du fil', () => {
  beforeEach(() => setOwner('Alex Durand'));
  test('texte en entier, retours à la ligne et puces gardés', () => {
    expect(htmlLines('<p>Bonjour,</p><p>Deux points :</p><ul><li>un</li><li>deux &amp; trois</li></ul><p>Merci</p>')).toBe('Bonjour,\nDeux points :\n• un\n• deux & trois\nMerci');
    const long = 'x'.repeat(600);
    expect(convFromPreview(preview({ body: { contentType: 'html', content: `<p>${long}</p><p>fin</p>` } }), ME)!.excerpt).toBe(`${long}\nfin`);
  });
  test('ce qui l’adresse à l’utilisateur : mention, prénom, question, citation d’un de ses messages', () => {
    expect(convMsgFrom(gm('1', T0, OTHER, '<at id="0">Alex Durand</at> tu valides ?'), ME)).toMatchObject({ who: 'other', mention: true, named: false, question: true, quotesMe: false, ack: false });
    expect(convMsgFrom(gm('2', T0, OTHER, 'Alex, tu peux regarder le dossier'), ME)).toMatchObject({ mention: false, named: true, question: false });
    expect(convMsgFrom(gm('2b', T0, OTHER, '<at id="0">Camille MARTIN</at> ton avis ?'), ME)).toMatchObject({ mention: false, question: false });
    const quote = { attachments: [{ contentType: 'messageReference', content: JSON.stringify({ messageId: '9', messageSender: { user: { id: ME } } }) }] };
    expect(convMsgFrom(gm('3', T0, OTHER, '<attachment id="9"></attachment><p>oui mais lequel</p>', quote), ME)).toMatchObject({ quotesMe: true, text: 'oui mais lequel' });
    expect(convMsgFrom(gm('4', T0, OTHER, '<p>Merci Alex, parfait</p>'), ME)).toMatchObject({ ack: true, named: true });
  });
  test('pièces jointes nommées ; événement système, message supprimé ou vide écartés ; les siens ne portent aucun drapeau', () => {
    expect(convMsgFrom(gm('1', T0, OTHER, '<p>voilà</p>', { attachments: [{ name: 'devis.pdf', contentType: 'reference' }] }), ME)!.text).toBe('voilà\n📎 devis.pdf');
    expect(convMsgFrom(gm('2', T0, OTHER, 'x', { messageType: 'systemEventMessage' }), ME)).toBeNull();
    expect(convMsgFrom(gm('3', T0, OTHER, 'x', { deletedDateTime: iso(T0) }), ME)).toBeNull();
    expect(convMsgFrom(gm('4', T0, OTHER, ''), ME)).toBeNull();
    expect(convMsgFrom(gm('5', T0, ME, 'Alex ici, une question ?'), ME)).toMatchObject({ who: 'me', named: false, question: false });
    expect(convThread([gm('b', T0 + MIN, OTHER, 'deux'), gm('a', T0, ME, 'un'), gm('s', T0, OTHER, 'x', { messageType: 'systemEventMessage' })], ME).map((m) => m.id)).toEqual(['a', 'b']);
  });
});

describe('à toi de répondre, sur tout le fil', () => {
  test('groupe : une question sans mention qui suit son message est pour lui ; une question entre collègues, non', () => {
    const mine = msg('1', T0 - 3 * MIN, { who: 'me', from: 'Alex Durand' });
    expect(row1(withThread([mine, msg('2', T0, { question: true })]))).toMatchObject({ ball: 'reply', why: 'question' });
    expect(row1(withThread([mine, msg('2', T0 - MIN), msg('3', T0, { question: true })]))).toMatchObject({ ball: null, why: null, unseen: true });
    expect(row1(withThread([msg('2', T0 - MIN), msg('3', T0, { question: true })]))).toMatchObject({ ball: null });
  });
  test('groupe : une mention suivie d’autres messages reste à répondre ; prénom et citation aussi', () => {
    const r = row1(withThread([msg('1', T0 - 2 * MIN, { mention: true, text: 'tu valides ?' }), msg('2', T0 - MIN, { text: 'moi oui' }), msg('3', T0, { ack: true, text: 'merci' })]));
    expect(r).toMatchObject({ ball: 'reply', why: 'mention' });
    expect(r.news.map((m) => m.text)).toEqual(['tu valides ?', 'moi oui', 'merci']);
    expect(row1(withThread([msg('1', T0, { named: true })]))).toMatchObject({ ball: 'reply', why: 'named' });
    expect(row1(withThread([msg('1', T0, { quotesMe: true })]))).toMatchObject({ ball: 'reply', why: 'quote' });
    expect(row1(withThread([msg('1', T0, { named: true, ack: true })]))).toMatchObject({ ball: null });
  });
  test('il a répondu depuis : plus rien à répondre ; « Rien à répondre » éteint jusqu’au prochain message adressé', () => {
    expect(row1(withThread([msg('1', T0 - 2 * MIN, { mention: true }), msg('2', T0 - MIN, { who: 'me' }), msg('3', T0)]))).toMatchObject({ ball: null });
    const t = [msg('1', T0 - 2 * MIN, { mention: true }), msg('2', T0)];
    expect(row1(withThread(t), T0)).toMatchObject({ ball: null, unseen: false, news: [] });
    expect(row1(withThread([...t, msg('3', T0 + MIN, { mention: true })]), T0)).toMatchObject({ ball: 'reply', unseen: true });
  });
  test('1:1 : un vrai message suivi d’un merci reste à répondre ; que des politesses, non', () => {
    expect(row1(withThread([msg('1', T0 - MIN, { text: 'tu as le devis ?' }), msg('2', T0, { ack: true })], { type: 'oneOnOne' }))).toMatchObject({ ball: 'reply', why: null });
    expect(row1(withThread([msg('1', T0 - MIN, { ack: true }), msg('2', T0, { ack: true })], { type: 'oneOnOne' }))).toMatchObject({ ball: null });
  });
  test('à voir : son propre message tapé vaut pointage ; celui d’une session, non — et il est montré', () => {
    const typed = [msg('1', T0 - 2 * MIN), msg('2', T0 - MIN, { who: 'me', from: 'Alex Durand' })];
    expect(row1(withThread(typed))).toMatchObject({ by: 'me', unseen: false, news: [] });
    const r = row1(withThread([msg('1', T0 - 2 * MIN, { text: 'question' }), msg('900', T0 - MIN, { who: 'me', from: 'Alex Durand', text: 'réponse de la session' })]), undefined, [wait({ messageId: '900', status: 'noreply' })]);
    expect(r).toMatchObject({ by: 'session', unseen: true });
    expect(r.news).toEqual([{ id: '1', at: T0 - 2 * MIN, from: 'Camille MARTIN', by: 'other', text: 'question' }, { id: '900', at: T0 - MIN, from: 'Alex Durand', by: 'session', text: 'réponse de la session' }]);
  });
  test('fil périmé (dernier message plus récent que le fil lu) : on retombe sur le dernier message seul', () => {
    const c = withThread([msg('1', T0 - MIN, { mention: true })]);
    expect(row1({ ...c, lastId: '2', lastAt: T0, mention: false })).toMatchObject({ ball: null, news: [], unseen: true });
  });
});

describe('passe, fil et réponse', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-')); setOwner('Alex Durand'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const LIST = '/me/chats?$expand=lastMessagePreview';
  const readState = () => JSON.parse(readFileSync(join(dir, '_conversations.json'), 'utf8')) as ConvState;
  const cfgOf = (o: Record<string, unknown> = {}) => ({ conversations: { ...defaultConversations, enabled: true, ...o } });
  function graphOf(pages: Record<string, unknown>, calls: string[]) {
    return async <T>(path: string): Promise<T> => {
      calls.push(path);
      const hit = Object.entries(pages).find(([k]) => path.startsWith(k));
      if (!hit) throw new Error(`Graph 404 sur ${path}`);
      return hit[1] as T;
    };
  }
  const list = (ids: [string, string][]) => ({ value: ids.map(([id, last], i) => ({ id, chatType: 'group', topic: `Sujet ${id}`, lastMessagePreview: preview({ id: last, createdDateTime: iso(T0 - i * MIN) }) })) });

  test('le fil n’est relu que si le dernier message a changé, dans la limite de la passe, les plus récents d’abord', async () => {
    const calls: string[] = [];
    const threads = { '/chats/a/messages': { value: [gm('1001', T0, OTHER, 'un')] }, '/chats/b/messages': { value: [gm('1002', T0 - MIN, OTHER, 'deux')] }, '/chats/c/messages': { value: [gm('1003', T0 - 2 * MIN, OTHER, 'trois')] } };
    const world = (l: [string, string][]) => graphOf({ [LIST]: list(l), ...threads }, calls);
    expect(await runConversations(dir, cfgOf({ threads: 2 }), ME, world([['a', '1001'], ['b', '1002'], ['c', '1003']]), { dryRun: false, now: NOW })).toMatchObject({ listed: 3, threads: 2 });
    expect(calls.filter((c) => c.includes('/messages'))).toEqual(['/chats/a/messages?$top=30&$orderby=createdDateTime desc', '/chats/b/messages?$top=30&$orderby=createdDateTime desc']);
    expect(readState().chats.a).toMatchObject({ recentFor: '1001', recent: [{ id: '1001', text: 'un' }] });
    expect(readState().chats.c!.recent).toBeUndefined();
    // Passe suivante : seul le fil pas encore lu l'est ; puis plus rien tant que rien ne bouge.
    calls.length = 0;
    expect((await runConversations(dir, cfgOf({ threads: 2 }), ME, world([['a', '1001'], ['b', '1002'], ['c', '1003']]), { dryRun: false, now: NOW + 2 * MIN })).threads).toBe(1);
    expect(calls.filter((c) => c.includes('/messages'))).toEqual(['/chats/c/messages?$top=30&$orderby=createdDateTime desc']);
    calls.length = 0;
    expect((await runConversations(dir, cfgOf({ threads: 2 }), ME, world([['a', '1001'], ['b', '1002'], ['c', '1003']]), { dryRun: false, now: NOW + 4 * MIN })).threads).toBeUndefined();
    expect(calls.filter((c) => c.includes('/messages'))).toEqual([]);
    // Un nouveau message dans b : son fil seul est relu.
    await runConversations(dir, cfgOf({ threads: 2 }), ME, world([['b', '2000'], ['a', '1001'], ['c', '1003']]), { dryRun: false, now: NOW + 6 * MIN });
    expect(calls.filter((c) => c.includes('/messages'))).toEqual(['/chats/b/messages?$top=30&$orderby=createdDateTime desc']);
    expect(readState().chats.b).toMatchObject({ lastId: '2000', recentFor: '2000' });
  });
  test('fil illisible : l’ancien est gardé, périmé, et relu à la passe suivante', async () => {
    const calls: string[] = [];
    await runConversations(dir, cfgOf(), ME, graphOf({ [LIST]: list([['a', '1001']]), '/chats/a/messages': { value: [gm('1001', T0, OTHER, 'un')] } }, calls), { dryRun: false, now: NOW });
    await runConversations(dir, cfgOf(), ME, graphOf({ [LIST]: list([['a', '2000']]) }, calls), { dryRun: false, now: NOW + 2 * MIN });
    expect(readState().chats.a).toMatchObject({ lastId: '2000', recentFor: '1001', recent: [{ id: '1001' }] });
    expect(conversationThread(dir, 'a')).toMatchObject({ fresh: false, messages: [{ id: '1001', by: 'other', text: 'un' }] });
    expect(conversationThread(dir, 'inconnu')).toBeNull();
  });

  test('réponse depuis la page : éteinte par défaut ; allumée, elle poste le texte échappé et tient la vue à jour', async () => {
    writeFileSync(join(dir, '_conversations.json'), JSON.stringify(state({ c1: withThread([msg('1', T0, { text: 'tu as le devis ?' })], { type: 'oneOnOne' }) })));
    const posts: { path: string; body: unknown }[] = [];
    const post = async (path: string, body: unknown) => { posts.push({ path, body }); return { id: '5000', createdDateTime: iso(T0 + 2 * MIN) }; };
    expect(await sendChatReply(dir, cfgOf(), 'c1', 'oui', NOW, post)).toMatch(/éteinte/);
    const on = cfgOf({ reply: true });
    expect(await sendChatReply(dir, on, 'c1', '   ', NOW, post)).toBe('message vide');
    expect(await sendChatReply(dir, on, 'inconnu', 'oui', NOW, post)).toBe('conversation introuvable');
    expect(posts).toEqual([]);
    expect(conversationsView(dir, NOW)!.rows[0]).toMatchObject({ ball: 'reply' });
    expect(await sendChatReply(dir, on, 'c1', 'Oui, <b>le voici</b> & merci\nÀ demain', NOW, post)).toBeNull();
    expect(posts).toEqual([{ path: '/chats/c1/messages', body: { body: { contentType: 'html', content: 'Oui, &lt;b&gt;le voici&lt;/b&gt; &amp; merci<br>À demain' } } }]);
    const r = conversationsView(dir, NOW)!.rows[0]!;
    expect(r).toMatchObject({ by: 'me', ball: null, unseen: false, lastAt: T0 + 2 * MIN, excerpt: 'Oui, <b>le voici</b> & merci\nÀ demain' });
    expect(conversationThread(dir, 'c1')!.messages.map((m) => [m.id, m.by])).toEqual([['1', 'other'], ['5000', 'me']]);
  });
  test('envoi refusé par Graph : l’erreur remonte, rien ne change', async () => {
    writeFileSync(join(dir, '_conversations.json'), JSON.stringify(state({ c1: chat() })));
    const err = await sendChatReply(dir, cfgOf({ reply: true }), 'c1', 'oui', NOW, async () => { throw new Error('Graph 403 sur /chats/<chat>/messages'); });
    expect(err).toBe('envoi refusé : Graph 403 sur /chats/<chat>/messages');
    expect(conversationsView(dir, NOW)!.rows[0]).toMatchObject({ by: 'other', ball: 'reply' });
  });
  test('portée d’envoi demandée au « login » seulement quand la réponse est allumée ; corps de réponse', () => {
    expect(loginScope(defaultConfig)).not.toContain('ChatMessage.Send');
    expect(loginScope({ ...defaultConfig, conversations: { ...defaultConversations, reply: true } })).toContain('ChatMessage.Send');
    expect(replyHtml('  a < b\r\nc  ')).toBe('a &lt; b<br>c');
  });
});
