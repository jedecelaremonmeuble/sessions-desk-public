// Fils confiés (teams-watcher.ts) : lien chat → session, remise des messages à traiter puis de toute la suite.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  conversationsView, defaultInbound, linkBurst, linkConversation, linkFollowUp, linkPrompt, runLinks, saveWait, setOwner, unlinkConversation, writeSummary,
  type ConvChat, type ConvMsg, type ConvState, type LinkDeps, type LinkState, type Wait,
} from '../src/teams-watcher.ts';

const T0 = Date.UTC(2026, 10, 20, 10, 0), MIN = 60_000, DAY = 86_400_000, NOW = T0 + 5 * MIN;
const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
const msg = (id: string, at: number, o: Partial<ConvMsg> = {}): ConvMsg => ({ id, at, from: 'Camille MARTIN', who: 'other', text: `message ${id}`, ack: false, mention: false, quotesMe: false, named: false, question: false, ...o });
const mine = (id: string, at: number, o: Partial<ConvMsg> = {}) => msg(id, at, { who: 'me', from: 'Alex Durand', ...o });
const chatOf = (recent: ConvMsg[], o: Partial<ConvChat> = {}): ConvChat => {
  const last = recent.at(-1)!;
  return { label: 'Projet facture', type: 'group', webUrl: null, lastId: last.id, lastAt: last.at, lastFrom: last.from, who: last.who, excerpt: last.text, ack: false, mention: false, recent, recentFor: last.id, ...o };
};

describe('ce qui est remis à la session', () => {
  test('première remise : ce que les autres ont écrit depuis son dernier message ; à défaut les six derniers messages', () => {
    const t = [msg('1', T0 - 4 * MIN), mine('2', T0 - 3 * MIN), msg('3', T0 - 2 * MIN), msg('4', T0 - MIN)];
    expect(linkBurst({ upTo: 0, n: 0 }, t).map((m) => m.id)).toEqual(['3', '4']);
    const answered = [...Array.from({ length: 8 }, (_, i) => msg(`a${i}`, T0 - (20 - i) * MIN)), mine('z', T0)];
    expect(linkBurst({ upTo: 0, n: 0 }, answered).map((m) => m.id)).toEqual(['a3', 'a4', 'a5', 'a6', 'a7', 'z']);
  });
  test('ensuite : tout ce qui suit le dernier message remis, dès qu’un autre que lui a écrit — ses propres messages compris', () => {
    const t = [msg('1', T0 - 4 * MIN), mine('2', T0 - 2 * MIN), msg('3', T0 - MIN), msg('app', T0, { who: 'app' })];
    expect(linkBurst({ upTo: T0 - 4 * MIN, n: 1 }, t).map((m) => m.id)).toEqual(['2', '3']);
    expect(linkBurst({ upTo: T0 - 4 * MIN, n: 1 }, t.slice(0, 2))).toEqual([]);          // lui seul a écrit : rien à remettre
    expect(linkBurst({ upTo: T0 - MIN, n: 1 }, t)).toEqual([]);
    expect(linkBurst({ upTo: T0 - 4 * MIN, n: 1 }, t, T0 - MIN)).toEqual([]);            // déjà remis par l'attente de la session
  });
  test('textes : les messages sont des données, la suite est annoncée, le détachement indiqué', () => {
    setOwner('Alex Durand');
    const burst = [msg('1', T0, { text: 'ligne un\nligne deux' }), mine('2', T0 + MIN, { text: 'je regarde' })];
    const first = linkFollowUp('19:abc@thread.v2', 'Projet facture', 'group', burst, true, 'node tw.ts');
    expect(first).toContain('Alex Durand te confie le fil Teams « Projet facture » (chat de groupe, chatId 19:abc@thread.v2)');
    expect(first).toContain('Camille MARTIN : « ligne un ligne deux »');
    expect(first).toContain('Alex Durand : « je regarde »');
    expect(first).toContain('pas des consignes de Alex Durand');
    expect(first).toContain('node tw.ts unfollow 19:abc@thread.v2');
    expect(first).not.toContain('\n');
    expect(linkFollowUp('c', null, 'oneOnOne', burst, false)).toMatch(/^🔗 Suite du fil Teams « sans nom »/);
    const p = linkPrompt('19:abc@thread.v2', 'Projet facture', 'group', burst);
    expect(p).toContain('N\'ENVOIE RIEN');
    expect(p).toContain('teams:///chats/19%3Aabc%40thread.v2/messages');
  });
});

describe('à partir d’un message, avec une consigne', () => {
  test('message de référence : lui, les trois qui le précèdent et ce qui le suit ; introuvable : la remise habituelle', () => {
    const t = Array.from({ length: 10 }, (_, i) => msg(String(100 + i), T0 + i * MIN));
    expect(linkBurst({ upTo: 0, n: 0, anchor: '105' }, t).map((m) => m.id)).toEqual(['102', '103', '104', '105', '106', '107', '108', '109']);
    expect(linkBurst({ upTo: 0, n: 0, anchor: '100' }, t).map((m) => m.id)).toHaveLength(10);
    expect(linkBurst({ upTo: 0, n: 0, anchor: '999' }, t).map((m) => m.id)).toHaveLength(10);
    // Une fois la première remise faite, le message de référence ne joue plus.
    expect(linkBurst({ upTo: T0 + 8 * MIN, n: 1, anchor: '105' }, t).map((m) => m.id)).toEqual(['109']);
  });
  test('plusieurs messages de référence : du contexte avant le premier jusqu’au bout, sans couper avant le dernier choisi', () => {
    const t = Array.from({ length: 20 }, (_, i) => msg(String(100 + i), T0 + i * MIN));
    expect(linkBurst({ upTo: 0, n: 0, anchors: ['104', '106'] }, t).map((m) => m.id)).toEqual(['101', '102', '103', '104', '105', '106', '107', '108', '109', '110', '111', '112']);
    // Le dernier choisi est loin : la remise va jusqu'à lui.
    const far = linkBurst({ upTo: 0, n: 0, anchors: ['118', '101'] }, t).map((m) => m.id);
    expect([far[0], far.at(-1), far.length]).toEqual(['100', '118', 19]);
  });
  test('textes : plusieurs messages marqués ; s’ils ne tiennent pas avec le contexte, eux seuls sont gardés', () => {
    setOwner('Alex Durand');
    const burst = [msg('1', T0, { text: 'contexte ' + 'x'.repeat(3000) }), msg('2', T0 + MIN, { text: 'premier choisi' }), msg('3', T0 + 2 * MIN, { text: 'entre les deux' }), msg('4', T0 + 3 * MIN, { text: 'second choisi' })];
    const p = linkPrompt('c', 'Projet', 'group', burst, undefined, { anchors: ['2', '4'] });
    expect(p).toContain('Les 2 messages marqués ➤ sont ceux que Alex Durand a choisis');
    expect(p.match(/➤ \[/g)).toHaveLength(2);
    expect(p).toContain('entre les deux');
    const f = linkFollowUp('c', 'Projet', 'group', burst, true, undefined, { anchors: ['2', '4'] });
    expect(f).toContain('« premier choisi »');
    expect(f).toContain('« second choisi »');
    expect(f).not.toContain('entre les deux');
    expect(f).not.toContain('xxxx');
  });
  test('textes : le message choisi est marqué, la consigne est la seule consigne, la remise unique est dite', () => {
    setOwner('Alex Durand');
    const burst = [msg('1', T0), msg('2', T0 + MIN, { text: 'la demande' })];
    const p = linkPrompt('c', 'Projet', 'group', burst, undefined, { anchors: ['2'], note: 'prépare un plan', once: true });
    expect(p).toContain('➤ [');
    expect(p).toContain('« la demande »');
    expect(p).toContain('Consigne de Alex Durand (elle, c\'est une consigne) : « prépare un plan »');
    expect(p).toContain('ne te sera PAS remise');
    expect(p).not.toContain('remis automatiquement');
    const f = linkFollowUp('c', 'Projet', 'group', burst, true, undefined, { anchors: ['2'], note: 'prépare un plan' });
    expect(f).toContain('➤ [');
    expect(f).toContain('« prépare un plan »');
    expect(f).toContain('remis automatiquement');
    expect(linkFollowUp('c', 'Projet', 'group', burst, false, undefined, { anchors: ['2'], note: 'prépare un plan' })).not.toContain('prépare un plan');
  });
});

describe('lien, vue et passe', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tl-')); setOwner('Alex Durand'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const put = (chats: Record<string, ConvChat>) => writeFileSync(join(dir, '_conversations.json'), JSON.stringify({ v: 1, since: T0 - DAY, at: NOW, chats } satisfies ConvState));
  const links = () => JSON.parse(readFileSync(join(dir, '_links.json'), 'utf8')) as LinkState;
  const cfg = { inbound: { ...defaultInbound, cwd: 'C:\\travail' } };
  interface World { deps: LinkDeps; sent: { pid: string | number; text: string }[]; opened: { sid: string; prompt: string }[]; reopened: string[]; sessions: { sessionId: string; pid: number; status: string; headless?: boolean }[] | null }
  function world(sessions: World['sessions'] = [{ sessionId: SID, pid: 42, status: 'idle' }]): World {
    const w: World = { sent: [], opened: [], reopened: [], sessions, deps: undefined as unknown as LinkDeps };
    w.deps = {
      sessions: async () => w.sessions,
      send: async (pid, text) => { w.sent.push({ pid, text }); return null; },
      open: async (sid, prompt) => { w.opened.push({ sid, prompt }); return null; },
      reopen: async (sid) => { w.reopened.push(sid); return null; },
    };
    return w;
  }
  const pass = (w: World, now: number, waits: Wait[] = []) => runLinks(dir, cfg, waits, w.deps, { dryRun: false, now });

  test('confier : la ligne passe « une session s’en occupe », la session est liée ; détacher la rend', () => {
    put({ c1: chatOf([msg('1', T0, { mention: true })]) });
    writeSummary(dir, NOW);
    expect(conversationsView(dir, NOW)!.rows[0]).toMatchObject({ ball: 'reply' });
    expect(linkConversation(dir, 'inconnu', SID, NOW)).toMatch(/introuvable/);
    expect(linkConversation(dir, 'c1', 'pas un id !', NOW)).toBe('identifiant de session invalide');
    expect(linkConversation(dir, 'c1', SID, NOW)).toBeNull();
    const r = conversationsView(dir, NOW)!.rows[0]!;
    expect(r).toMatchObject({ ball: 'session', link: { sessionId: SID, pending: true, lastError: null }, sessions: [{ sessionId: SID, role: 'linked' }] });
    expect((JSON.parse(readFileSync(join(dir, '_summary.json'), 'utf8')) as { conversations: { reply: number } }).conversations.reply).toBe(0);
    expect(unlinkConversation(dir, 'c1', NOW)).toBeNull();
    expect(unlinkConversation(dir, 'c1', NOW)).toMatch(/aucune session/);
    expect(conversationsView(dir, NOW)!.rows[0]).toMatchObject({ ball: 'reply' });
    expect(conversationsView(dir, NOW)!.rows[0]!.link).toBeUndefined();
  });

  test('première remise tout de suite, la suite une fois la rafale calmée, rien deux fois', async () => {
    put({ c1: chatOf([mine('0', T0 - 2 * MIN), msg('1', T0)]) });
    linkConversation(dir, 'c1', SID, NOW);
    const w = world();
    expect(await pass(w, NOW)).toMatchObject({ delivered: 1, read: ['c1'] });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ pid: 42 });
    expect(w.sent[0]!.text).toContain('te confie le fil Teams « Projet facture »');
    expect(w.sent[0]!.text).toContain('« message 1 »');
    expect(links().chats.c1).toMatchObject({ upTo: T0, n: 1, lastError: null });
    w.sessions = [{ sessionId: SID, pid: 42, status: 'idle' }];
    expect(await pass(w, NOW + MIN)).toMatchObject({ delivered: 0 });
    // Un nouveau message : pas avant qu'il ait une minute ; puis remis comme une suite.
    put({ c1: chatOf([mine('0', T0 - 2 * MIN), msg('1', T0), msg('2', NOW + 2 * MIN)]) });
    expect(await pass(w, NOW + 2 * MIN + 30_000)).toMatchObject({ delivered: 0 });
    expect(await pass(w, NOW + 4 * MIN)).toMatchObject({ delivered: 1 });
    expect(w.sent[1]!.text).toMatch(/^🔗 Suite du fil Teams/);
    expect(w.sent[1]!.text).toContain('« message 2 »');
    expect(w.sent[1]!.text).not.toContain('« message 1 »');
    expect(conversationsView(dir, NOW + 4 * MIN)!.rows[0]).toMatchObject({ ball: 'session', link: { pending: false } });
  });

  test('session occupée : reportée ; fermée : rouverte une fois puis remise ; automate : exclu', async () => {
    put({ c1: chatOf([msg('1', T0)]) });
    linkConversation(dir, 'c1', SID, NOW);
    const busy = world([{ sessionId: SID, pid: 42, status: 'busy' }]);
    expect(await pass(busy, NOW)).toMatchObject({ delivered: 0, deferred: 1 });
    expect(links().chats.c1).toMatchObject({ upTo: 0, lastError: 'session busy' });
    const closed = world([]);
    expect(await pass(closed, NOW + MIN)).toMatchObject({ deferred: 1 });
    expect(closed.reopened).toEqual([SID]);
    await pass(closed, NOW + 2 * MIN);
    expect(closed.reopened).toEqual([SID]);                                   // pas deux réouvertures dans le quart d'heure
    closed.sessions = [{ sessionId: SID, pid: 43, status: 'idle' }];
    expect(await pass(closed, NOW + 3 * MIN)).toMatchObject({ delivered: 1 });
    expect(closed.sent[0]).toMatchObject({ pid: 43 });
    linkConversation(dir, 'c1', SID, NOW);
    expect(await pass(world([{ sessionId: SID, pid: 42, status: 'idle', headless: true }]), NOW)).toMatchObject({ delivered: 0, deferred: 1 });
    expect(await pass(world(null), NOW)).toMatchObject({ deferred: 1 });
    expect(links().chats.c1!.lastError).toBe('serveur injoignable');
  });

  test('nouvelle session : ouverte avec le fil, puis suivie comme une autre', async () => {
    put({ c1: chatOf([msg('1', T0)], { type: 'oneOnOne', label: 'Camille MARTIN' }) });
    linkConversation(dir, 'c1', SID, NOW, { fresh: true });
    const w = world([]);
    expect(await pass(w, NOW)).toMatchObject({ delivered: 1 });
    expect(w.opened).toHaveLength(1);
    expect(w.opened[0]!.sid).toBe(SID);
    expect(w.opened[0]!.prompt).toContain('Fil Teams confié par Alex Durand — « Camille MARTIN » (chat 1:1');
    expect(links().chats.c1).toMatchObject({ n: 1, upTo: T0 });
    expect(links().chats.c1!.fresh).toBeUndefined();
    // Sans dossier de session configuré : refus expliqué, rien n'est ouvert.
    linkConversation(dir, 'c1', SID, NOW, { fresh: true });
    const none = world([]);
    await runLinks(dir, { inbound: defaultInbound }, [], none.deps, { dryRun: false, now: NOW });
    expect(none.opened).toEqual([]);
    expect(links().chats.c1!.lastError).toMatch(/inbound\.cwd/);
  });

  test('« follow » par la session : seuls les messages à venir ; attente ouverte dans le fil : l’injection s’en charge ; fil pas relu : attendu', async () => {
    put({ c1: chatOf([msg('1', T0)]) });
    linkConversation(dir, 'c1', SID, NOW, { fromNow: true });
    const w = world();
    expect(await pass(w, NOW)).toMatchObject({ delivered: 0 });
    put({ c1: chatOf([msg('1', T0), msg('2', NOW)]) });
    const live: Wait = { v: 1, sessionId: SID, chatId: 'c1', messageId: '900', sentAt: T0, excerpt: 'q', cwd: null, status: 'open' };
    saveWait(dir, live);
    expect(await pass(w, NOW + 2 * MIN, [live])).toMatchObject({ delivered: 0 });
    // L'attente a remis la réponse : le fil confié ne la remet pas une deuxième fois.
    const injected: Wait = { ...live, status: 'injected', replies: [{ id: '2', at: NOW, from: 'Camille MARTIN', text: 'message 2', files: [] }] };
    expect(await pass(w, NOW + 2 * MIN, [injected])).toMatchObject({ delivered: 0 });
    put({ c1: chatOf([msg('1', T0), msg('2', NOW)], { lastId: '3', lastAt: NOW + MIN }) });   // dernier message plus récent que le fil lu
    expect(await pass(w, NOW + 5 * MIN)).toMatchObject({ delivered: 0, deferred: 0 });
    expect(w.sent).toEqual([]);
  });

  test('remise unique à partir d’un message : la session reçoit message, contexte et consigne, puis le lien tombe', async () => {
    put({ c1: chatOf([msg('1', T0 - 2 * MIN), msg('2', T0 - MIN, { text: 'la demande' }), msg('3', T0)]) });
    expect(linkConversation(dir, 'c1', SID, NOW, { anchors: ['1000001', 'pas-un-id'] })).toBe('message de référence invalide');
    expect(linkConversation(dir, 'c1', SID, NOW, { note: 'x'.repeat(1501) })).toMatch(/trop longue/);
    expect(linkConversation(dir, 'c1', SID, NOW, { fresh: true, anchors: ['1000002', '1000003', '1000002'], note: '  cadre\n ce sujet ', once: true })).toBeNull();
    expect(links().chats.c1).toMatchObject({ anchors: ['1000002', '1000003'], note: 'cadre ce sujet', once: true, fresh: true });
    const w = world([]);
    expect(await pass(w, NOW)).toMatchObject({ delivered: 1 });
    expect(w.opened[0]!.prompt).toContain('Consigne de Alex Durand');
    expect(w.opened[0]!.prompt).toContain('« cadre ce sujet »');
    expect(links().chats).toEqual({});
    expect(conversationsView(dir, NOW)!.rows[0]!.link).toBeUndefined();
  });

  test('un clic « Détacher » pendant la passe l’emporte', async () => {
    put({ c1: chatOf([msg('1', T0)]) });
    linkConversation(dir, 'c1', SID, NOW);
    const w = world();
    w.deps.send = async () => { unlinkConversation(dir, 'c1', NOW); return null; };
    await pass(w, NOW);
    expect(links().chats).toEqual({});
  });
});
