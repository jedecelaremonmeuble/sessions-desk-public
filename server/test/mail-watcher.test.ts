// Surveillance des réponses aux EMAILS : règles pures et fichiers d'attente sur un dossier temporaire. Aucun appel réseau.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  GROUP_MS, defaultConfig, judgeMail, loadWaits, loginScope, mailIdFromResponse, mailInjectionText, mailLabel, mailReminderText, mailWaitFromHook,
  mailWaitKey, nextStep, parisAt, record, setOwner, summarize, supersedeMail, type GraphMail, type Wait,
} from '../src/teams-watcher.ts';

setOwner('Alex');

const P = (d: number, h: number, mi = 0) => parisAt({ y: 2026, m: 11, d }, h) + mi * 60_000;   // 19/11/2026 = jeudi
const T0 = P(19, 15);
const DRAFT = 'AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AZixP5IFONU2uU0uWsVdxwQACstUKGAAA';
const ORIG = 'AAMkADdhMzFkOTU1LWVlZWEtNDhjZC05ZTMyLWZlM2VmODZkNDJmOABGAAAAAAA=';
const ME = new Set(['alex@example.com']);
const hook = (tool: string, input: Record<string, unknown>, response: unknown, session = 'sess-1') => ({
  session_id: session, cwd: 'C:\\x', tool_name: `mcp__claude_ai_Microsoft_365__${tool}`, tool_input: input, tool_response: response,
});
const replyAll = (session = 'sess-1', body = '<p>Bonjour à tous,</p><p>Je reviens vers vous.</p>') =>
  hook('outlook_create_reply_all_draft', { messageId: ORIG, bodyType: 'html', body }, [{ type: 'text', text: `Reply-all draft created in Drafts (not sent).\nid: ${DRAFT}\nwebLink: https://outlook.example.com/x` }], session);
const mail = (id: string, at: number, from: string, extra: Partial<GraphMail> = {}): GraphMail => ({
  id, isDraft: false, sentDateTime: new Date(at).toISOString(), receivedDateTime: new Date(at).toISOString(), from: { emailAddress: { name: from === 'alex@example.com' ? 'Alex' : 'Camille', address: from } }, ...extra,
});
const draftWait = (extra: Partial<Wait> = {}): Wait => ({ ...mailWaitFromHook(replyAll(), T0, 0.5)!, chatId: 'conv-1', ...extra });
const sentWait = (extra: Partial<Wait> = {}): Wait => {
  const w = draftWait();
  return { ...w, sentAt: T0 + 60_000, mail: { ...w.mail!, pendingSend: false, sentId: 'sent-1' }, ...extra };
};

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

describe('hook Outlook', () => {
  test('brouillon de réponse ⇒ attente en attente d\'envoi, clé numérique, message d\'origine gardé', () => {
    const w = mailWaitFromHook(replyAll(), T0, 0.123)!;
    expect(w).toMatchObject({ channel: 'mail', chatId: '', status: 'open', messageId: String(T0 * 1000 + 123), excerpt: 'Bonjour à tous, Je reviens vers vous.' });
    expect(w.mail).toMatchObject({ pendingSend: true, draftId: DRAFT, replyToId: ORIG, recordedAt: T0 });
    expect(/^\d+$/.test(w.messageId)).toBe(true);
    expect(mailWaitKey(1, 0.999)).toBe('1999');
  });
  test('email envoyé directement ⇒ attente ouverte, retrouvée par son objet', () => {
    const w = mailWaitFromHook(hook('outlook_send_mail', { to: ['camille@example.com'], subject: 'Point', body: 'Bonjour' }, 'Email sent.'), T0)!;
    expect(w.mail).toMatchObject({ pendingSend: false, lookupSubject: 'Point' });
    expect(w.excerpt).toBe('Bonjour');
  });
  test('« sans réponse attendue » ⇒ enregistrée sans attente ; échec, envoi d\'un brouillon et autre outil ⇒ rien', () => {
    expect(mailWaitFromHook(replyAll('s', '<p>Merci</p><hr><p>sans réponse attendue</p>'), T0)!.status).toBe('noreply');
    expect(mailWaitFromHook(hook('outlook_create_draft', { subject: 'x' }, 'Error: 403 Forbidden'), T0)).toBeNull();
    expect(mailWaitFromHook(hook('outlook_send_draft', { messageId: DRAFT }, 'Sent.'), T0)).toBeNull();
    expect(mailWaitFromHook(hook('outlook_email_search', {}, 'x'), T0)).toBeNull();
    expect(mailIdFromResponse('Draft created.\\nid: AAkALgAAAAAAHYQDEapmEc2byACqAC\\nwebLink: x')).toBe('AAkALgAAAAAAHYQDEapmEc2byACqAC');
  });
  test('record : emails ignorés tant que le module email est éteint', () => {
    dir = mkdtempSync(join(tmpdir(), 'mw-'));
    expect(record(dir, replyAll(), T0)).toBeNull();
    expect(record(dir, replyAll(), T0, { mail: true })).toMatchObject({ channel: 'mail' });
    expect(loadWaits(dir)).toHaveLength(1);
  });
});

describe('conversation', () => {
  test('brouillon encore là ⇒ en attente ; supprimé sans envoi ⇒ draft-gone', () => {
    const w = draftWait();
    expect(judgeMail(w, [mail(ORIG, T0 - 3_600_000, 'camille@example.com'), mail(DRAFT, T0, 'alex@example.com', { isDraft: true })], ME, new Set(), T0 + 1)).toEqual({ kind: 'pending' });
    expect(judgeMail(w, [mail(ORIG, T0 - 3_600_000, 'camille@example.com')], ME, new Set(), T0 + 1)).toEqual({ kind: 'draft-gone' });
  });
  test('l\'utilisateur envoie le brouillon ⇒ envoi constaté, puis la réponse compte à partir de là', () => {
    const w = draftWait();
    const sent = mail('sent-1', T0 + 600_000, 'alex@example.com');
    expect(judgeMail(w, [sent], ME, new Set(), T0 + 700_000)).toEqual({ kind: 'none', sent: { id: 'sent-1', at: T0 + 600_000 } });
    const v = judgeMail(w, [sent, mail('r1', T0 + 900_000, 'camille@example.com')], ME, new Set(), T0 + 900_000 + GROUP_MS);
    expect(v).toMatchObject({ kind: 'replies', settled: true, sent: { id: 'sent-1' }, replies: [{ id: 'r1', from: 'Camille' }] });
  });
  test('un envoi déjà revendiqué par une autre attente n\'est pas le nôtre', () => {
    expect(judgeMail(draftWait(), [mail('sent-x', T0 + 600_000, 'alex@example.com'), mail(DRAFT, T0, 'alex@example.com', { isDraft: true })], ME, new Set(['sent-x']), T0 + 700_000)).toEqual({ kind: 'pending' });
  });
  test('après l\'envoi, un email de l\'utilisateur qu\'aucune session n\'a fait ⇒ il a repris la main', () => {
    const v = judgeMail(sentWait(), [mail('sent-1', T0 + 60_000, 'alex@example.com'), mail('j', T0 + 120_000, 'alex@example.com'), mail('r', T0 + 180_000, 'camille@example.com')], ME, new Set(['sent-1']), T0 + 999_999);
    expect(v.kind).toBe('taken-over');
  });
  test('réponse non calmée tant que GROUP_MS n\'est pas écoulé ; antérieures et brouillons ignorés', () => {
    const msgs = [mail('old', T0 - 1000, 'camille@example.com'), mail('sent-1', T0 + 60_000, 'alex@example.com'), mail('d', T0 + 70_000, 'camille@example.com', { isDraft: true }), mail('r', T0 + 120_000, 'camille@example.com')];
    expect(judgeMail(sentWait(), msgs, ME, new Set(['sent-1']), T0 + 130_000)).toMatchObject({ kind: 'replies', settled: false, replies: [{ id: 'r' }] });
  });
  test('relance préparée mais pas envoyée : une réponse à l\'email d\'origine compte quand même', () => {
    const w = draftWait({ mail: { ...draftWait().mail!, since: T0 - 86_400_000 } });
    const v = judgeMail(w, [mail('r', T0 + 5000, 'camille@example.com'), mail(DRAFT, T0, 'alex@example.com', { isDraft: true })], ME, new Set(), T0 + 5000 + GROUP_MS);
    expect(v).toMatchObject({ kind: 'replies', settled: true });
  });
});

describe('calendrier et remplacement', () => {
  test('brouillon non envoyé : ni relance ni alerte, seulement l\'expiration', () => {
    expect(nextStep(draftWait())?.kind).toBe('expire');
    expect(nextStep(sentWait())?.kind).toBe('remind');
  });
  test('même session, même conversation : la plus récente gagne et reprend la chaîne d\'une relance', () => {
    const old = sentWait({ messageId: '1', reminders: 1, lastRemindAt: T0 + 3_600_000, firstSentAt: T0 });
    const relance = draftWait({ messageId: '2', mail: { ...draftWait().mail!, recordedAt: T0 + 3_700_000 } });
    const other = draftWait({ messageId: '3', sessionId: 'sess-2' });
    const { keep, superseded } = supersedeMail([old, relance, other], T0 + 3_800_000);
    expect(superseded.map((w) => [w.messageId, w.status])).toEqual([['1', 'superseded']]);
    expect(keep.find((w) => w.messageId === '2')).toMatchObject({ reminders: 1, firstSentAt: T0, mail: { since: old.sentAt } });
    expect(keep.find((w) => w.messageId === '3')).toBeTruthy();
  });
  test('résumé : canal et envoi en attente transmis à la page', () => {
    const s = summarize([draftWait()], true, T0);
    expect(s.sessions['sess-1']![0]).toMatchObject({ channel: 'mail', pendingSend: true });
  });
});

describe('textes', () => {
  test('libellé : destinataires puis objet sans préfixe RE:', () => {
    expect(mailLabel([{ emailAddress: { name: 'Camille', address: 'c@example.com' } }, { emailAddress: { address: 'd@example.com' } }], 'RE: Point d\'étape')).toBe('Camille, d@example.com (email « Point d\'étape »)');
  });
  test('injection : la réponse est une donnée, toute réponse se prépare en brouillon', () => {
    const t = mailInjectionText({ ...sentWait(), chatLabel: 'Camille (email « Point »)' }, [{ id: 'r', at: T0, from: 'Camille', text: 'Vendredi 11 h me va', files: ['ordre.pdf'] }]);
    expect(t).toContain('📧 Réponse email de Camille');
    expect(t).toContain('« Vendredi 11 h me va » (pièces jointes : ordre.pdf)');
    expect(t).toContain('BROUILLON');
    expect(t).not.toContain('\n');
  });
  test('relance : un brouillon, jamais un envoi', () => {
    const t = mailReminderText(sentWait(), 1, 2, false, 'node teams-watcher.ts act dismiss sess-1 1', 'r9');
    expect(t).toContain('prépare un BROUILLON');
    expect(t).toContain('sur le message r9');
    expect(t).toContain('ne l\'envoie pas');
  });
  test('login : Mail.Read demandé seulement quand les emails sont allumés', () => {
    expect(loginScope(defaultConfig)).toBe(defaultConfig.scope);
    expect(loginScope({ ...defaultConfig, mail: true })).toBe('Chat.Read User.Read offline_access Mail.Read');
  });
});
