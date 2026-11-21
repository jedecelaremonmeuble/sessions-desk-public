// Validations métier : la session qualifie une réponse, le veilleur garde la preuve et refuse ce qu'aucun
// message connu ne porte. Dossiers temporaires, aucun appel réseau.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  appendValEvent, buildValEvent, exportTarget, foldValidations, runExports, validationNoteHtml, validationSummaries, injectionText, inboundPrompt, linkedWait, loadValEvents, mailInjectionText, normDecision, openQuestions, parseFlags, reminderQuestions, saveEvidence, saveWait,
  setOwner, validationCommand, validationHint, validationsDir, waitFromHook, TOOL, type Evidence, type Reply, type ValDecision, type ValEvent, type Wait,
} from '../src/teams-watcher.ts';

setOwner('Alex');
const SID = 'sess-1', NOW = 1795080000000;
const reply = (id: string, from: string, text: string, at = NOW - 60_000): Reply => ({ id, at, from, text, files: [] });
const ev = (r: Reply, channel: Evidence['channel'] = 'teams'): Evidence => ({ v: 1, channel, chatId: '19:abc', messageId: r.id, from: r.from, at: r.at, text: r.text });
const R1 = reply('1795079940000', 'Camille Martin', 'Oui pour la date de prochaine action, on le sort des salves jusqu’à cette date.');
const base = { q: 'Q1', question: 'Sortir le client des salves jusqu’à la date de prochaine action ?', decision: 'valide', channel: 'teams', message: R1.id, quote: 'on le sort des salves' };

describe('qualification (pur)', () => {
  test('une réponse connue devient un événement : auteur et preuve viennent du message', () => {
    const r = buildValEvent('record', base, SID, [ev(R1)], NOW, 'e1');
    expect(r).toMatchObject({ event: { kind: 'answer', q: 'Q1', decision: 'valide', validator: 'Camille Martin', channel: 'teams', evidence: { chatId: '19:abc', messageId: R1.id }, recordedBy: 'session' } });
  });
  test('message inconnu : refusé (pas de validation sans preuve)', () => {
    expect(buildValEvent('record', base, SID, [], NOW, 'e1')).toMatchObject({ error: expect.stringContaining('inconnu') });
  });
  test('validation prêtée à un autre que l’auteur : refusée', () => {
    expect(buildValEvent('record', { ...base, validator: 'Dominique Petit' }, SID, [ev(R1)], NOW, 'e1')).toMatchObject({ error: expect.stringContaining('est de Camille Martin') });
    // même personne, casse et accents différents : accepté
    expect(buildValEvent('record', { ...base, validator: 'camille MARTIN' }, SID, [ev(R1)], NOW, 'e1')).toHaveProperty('event');
  });
  test('citation reformulée : refusée ; apostrophes et espaces tolérés', () => {
    expect(buildValEvent('record', { ...base, quote: 'elle est d’accord pour sortir le client' }, SID, [ev(R1)], NOW, 'e1')).toMatchObject({ error: expect.stringContaining('EXACT') });
    expect(buildValEvent('record', { ...base, quote: "jusqu'à   cette date" }, SID, [ev(R1)], NOW, 'e1')).toHaveProperty('event');
  });
  test('champs obligatoires nommés', () => {
    const err = (f: Record<string, string>) => (buildValEvent('record', { ...base, ...f }, SID, [ev(R1)], NOW, 'e') as { error?: string }).error;
    expect(err({ q: 'Q 1' })).toContain('--q');
    expect(err({ question: '' })).toContain('--question');
    expect(err({ decision: 'peut-être' })).toContain('--decision');
    expect(err({ decision: 'valide-reserve' })).toContain('--reserve');
    expect(err({ quote: '' })).toContain('--quote');
    expect(err({ quote: 'x'.repeat(501) })).toContain('500');
    expect(err({ channel: 'sms' })).toContain('--channel');
    expect(err({ message: '' })).toContain('--message');
  });
  test('rapportée par l’utilisateur : sans message, mais le validateur est nommé', () => {
    const f = { q: 'Q2', question: 'Garder l’offre ?', decision: 'refuse', channel: 'relayed', quote: 'Dominique m’a dit non au téléphone' };
    expect(buildValEvent('record', f, SID, [], NOW, 'e')).toMatchObject({ error: expect.stringContaining('--validator') });
    expect(buildValEvent('record', { ...f, validator: 'Dominique Petit' }, SID, [], NOW, 'e')).toMatchObject({ event: { channel: 'relayed', evidence: null, validator: 'Dominique Petit', decision: 'refuse' } });
  });
  test('décisions : variantes acceptées', () => {
    expect(['validé', 'OK', 'sous réserve', 'validé_sous_réserve', 'refusé', 'non', 'à préciser', 'x'].map(normDecision))
      .toEqual(['valide', 'valide', 'valide-reserve', 'valide-reserve', 'refuse', 'refuse', 'a-preciser', null]);
  });
  test('drapeaux : --clé valeur, --clé=valeur, drapeau vide', () => {
    expect(parseFlags(['--q', 'Q1', '--quote=a b', '--x', '--y', 'z'])).toEqual({ q: 'Q1', quote: 'a b', x: '', y: 'z' });
  });
});

describe('historique (pur)', () => {
  const e = (q: string, at: number, decision: ValDecision, extra: Partial<ValEvent> = {}): ValEvent =>
    ({ v: 1, evt: q + at, kind: 'answer', at, sessionId: SID, q, question: 'question ' + q, decision, validator: 'Camille Martin', channel: 'teams', quote: 'x', recordedBy: 'session', ...extra });
  test('le dernier événement d’une question l’emporte, les changements sont comptés', () => {
    const s = foldValidations([e('Q1', 3, 'valide'), e('Q1', 1, 'a-preciser'), e('Q2', 2, 'refuse')]);
    expect(s.items.map((i) => [i.q, i.decision, i.changes])).toEqual([['Q1', 'valide', 1], ['Q2', 'refuse', 0]]);
    expect(s).toMatchObject({ total: 2, settled: 2, refused: 1, pending: 0 });
  });
  test('à préciser reste en attente ; retrait sorti des compteurs', () => {
    const s = foldValidations([e('Q1', 1, 'a-preciser'), e('Q2', 2, 'valide'), { v: 1, evt: 'w', kind: 'withdraw', at: 3, sessionId: SID, q: 'Q2', recordedBy: 'session', note: 'hors sujet' }]);
    expect(s).toMatchObject({ total: 1, settled: 0, pending: 1 });
    expect(s.items.find((i) => i.q === 'Q2')).toMatchObject({ withdrawn: true, changes: 1 });
  });
});

describe('consignes d’injection', () => {
  const w = waitFromHook({ session_id: SID, cwd: null, tool_name: TOOL, tool_input: { chatId: '19:abc', body: '<p>Q1 : on sort le client des salves ?</p>' }, tool_response: `id: ${NOW - 600_000}` }, NOW)!;
  test('sans commande : texte inchangé (rétrocompatible)', () => {
    expect(injectionText(w, [R1])).not.toContain('validation record');
  });
  test('avec commande : session, canal et ids des messages donnés', () => {
    const t = injectionText(w, [R1], 'node tw.ts');
    expect(t).toContain(`node tw.ts validation record --session ${SID} --channel teams`);
    expect(t).toContain(`${R1.id} (Camille Martin)`);
    expect(t).toContain('pas un go');
    expect(t).not.toContain('\n');
    expect(mailInjectionText({ ...w, channel: 'mail' }, [R1], 'node tw.ts')).toContain('--channel mail');
    expect(inboundPrompt('19:abc', 'Camille', [R1], 'node tw.ts', 'sess-2')).toContain('--session sess-2 --channel inbound');
  });
  test('la consigne tient dans une injection', () => {
    expect(validationHint('node "C:/x/teams-watcher.ts"', SID, 'teams', [R1, R1]).length).toBeLessThan(700);
  });
});

describe('commande (fichiers)', () => {
  let root = '', dir = '';
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'tv-')); dir = join(root, 'teams-waits'); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  const run = (...argv: string[]) => validationCommand(dir, argv, { CLAUDE_CODE_SESSION_ID: SID, CLAUDE_CODE_ENTRYPOINT: 'cli' }, NOW, 'evt-' + argv.length);
  const args = (f: Record<string, string>) => Object.entries(f).flatMap(([k, v]) => ['--' + k, v]);

  test('preuve gardée une fois, validation ajoutée au journal et au résumé de la page', () => {
    const vdir = validationsDir(dir);
    expect(vdir).toBe(join(root, 'session-validations'));
    saveEvidence(vdir, SID, 'teams', '19:abc', [R1]); saveEvidence(vdir, SID, 'teams', '19:abc', [R1]);
    expect(readFileSync(join(vdir, `${SID}.evidence.jsonl`), 'utf8').trim().split('\n')).toHaveLength(1);
    const [code, out] = run('record', ...args(base));
    expect(code).toBe(0); expect(out).toContain('Q1 : validé par Camille Martin'); expect(out).toContain('sans --hd : recopiée sur aucun ticket');
    expect(loadValEvents(vdir, SID)).toHaveLength(1);
    const sum = JSON.parse(readFileSync(join(dir, '_summary.json'), 'utf8'));
    expect(sum.validations[SID]).toMatchObject({ total: 1, settled: 1, items: [{ q: 'Q1', validator: 'Camille Martin', decision: 'valide' }] });
    // réenregistrée avec son ticket : un événement de plus, la même question
    expect(run('record', ...args({ ...base, hd: 'TCK-111111' }))[1]).toContain('sera recopiée sur TCK-111111');
    expect(loadValEvents(vdir, SID)).toHaveLength(2);
  });
  test('refus : rien n’est écrit', () => {
    const [code, out] = run('record', ...args(base));
    expect(code).toBe(1); expect(out).toContain('inconnu');
    expect(loadValEvents(validationsDir(dir), SID)).toEqual([]);
  });
  test('retrait d’une question inconnue refusé ; connue accepté', () => {
    expect(run('withdraw', '--q', 'Q1', '--note', 'doublon')[0]).toBe(1);
    expect(run('record', ...args({ ...base, channel: 'relayed', validator: 'Camille Martin', message: '' }))[0]).toBe(0);
    expect(run('withdraw', '--q', 'Q1', '--note', 'doublon')).toEqual([0, 'Q1 retirée']);
    expect(JSON.parse(run('list')[1])).toMatchObject({ total: 0, items: [{ q: 'Q1', withdrawn: true }] });
  });
  test('sans id de session ou depuis un automate : refusé', () => {
    expect(validationCommand(dir, ['list'], {}, NOW, 'e')[0]).toBe(1);
    expect(validationCommand(dir, ['record', ...args(base)], { CLAUDE_CODE_SESSION_ID: SID, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, NOW, 'e')).toEqual([1, expect.stringContaining('automates')]);
  });
});

describe('validations attendues', () => {
  const H = 3_600_000;
  const w0 = (over: Partial<Wait> = {}): Wait => ({ ...waitFromHook({ session_id: SID, cwd: null, tool_name: TOOL, tool_input: { chatId: '19:abc', body: '<p>Q1, Q2 ?</p>' }, tool_response: `id: ${NOW}` }, NOW + 1000)!, ...over });
  const expectEv = (q: string, at = NOW - 60_000, extra: Partial<ValEvent> = {}): ValEvent => ({ ...(buildValEvent('expect', { q, question: 'question ' + q, to: 'Camille Martin' }, SID, [], at, 'x' + q) as { event: ValEvent }).event, ...extra });
  const answer = (q: string, at: number, decision: ValDecision = 'valide'): ValEvent => ({ v: 1, evt: 'a' + q, kind: 'answer', at, sessionId: SID, q, question: 'question ' + q, decision, validator: 'Camille Martin', channel: 'teams', evidence: { chatId: '19:abc', messageId: R1.id, at }, quote: 'x', recordedBy: 'session' });

  test('expect : question et destinataire obligatoires', () => {
    expect(buildValEvent('expect', { q: 'Q1', question: 'x' }, SID, [], NOW, 'e')).toMatchObject({ error: expect.stringContaining('--to') });
    expect(buildValEvent('expect', { q: 'Q1', to: 'Camille' }, SID, [], NOW, 'e')).toMatchObject({ error: expect.stringContaining('--question') });
    expect(buildValEvent('expect', { q: 'Q1', question: 'x', to: 'Camille', chat: '19:abc' }, SID, [], NOW, 'e')).toMatchObject({ event: { kind: 'expect', to: 'Camille', chat: '19:abc' } });
  });
  test('rattachée à l’attente envoyée juste après, puis à la relance qui la remplace', () => {
    const a = w0(), relance = { ...w0(), messageId: String(NOW + 5 * H), sentAt: NOW + 5 * H };
    expect(linkedWait(expectEv('Q1'), [a])?.messageId).toBe(a.messageId);
    expect(linkedWait(expectEv('Q1'), [{ ...a, status: 'superseded' }, relance])?.messageId).toBe(relance.messageId);
    expect(linkedWait(expectEv('Q1', NOW - 2 * H), [a])).toBeNull();          // trop loin : pas ce message-là
    expect(linkedWait(expectEv('Q1', NOW, { chat: '19:autre' }), [a])).toBeNull(); // fil précisé : autre chat
  });
  test('états : attendue, tranchée, non qualifiée après 2 h, sans réponse à l’expiration', () => {
    const s = foldValidations([expectEv('Q1'), expectEv('Q2'), answer('Q1', NOW + H)], [w0()], NOW + 2 * H);
    expect(s.items.map((i) => [i.q, i.state, i.to])).toEqual([['Q1', 'tranchee', 'Camille Martin'], ['Q2', 'attendue', 'Camille Martin']]);
    expect(s).toMatchObject({ total: 2, settled: 1, expected: 1, unqualified: 0 });
    const inj = w0({ status: 'injected', injectedAt: NOW + H });
    expect(foldValidations([expectEv('Q2')], [inj], NOW + 2 * H).items[0]!.state).toBe('attendue');
    expect(foldValidations([expectEv('Q2')], [inj], NOW + 3.5 * H)).toMatchObject({ unqualified: 1, items: [{ state: 'non-qualifiee' }] });
    expect(foldValidations([expectEv('Q2')], [w0({ status: 'expired' })], NOW + 9 * H)).toMatchObject({ unanswered: 1, items: [{ state: 'sans-reponse' }] });
  });
  test('une déclaration tardive ne rouvre pas une question tranchée', () => {
    const s = foldValidations([answer('Q1', NOW), expectEv('Q1', NOW + H)], [], NOW + 2 * H);
    expect(s.items[0]).toMatchObject({ state: 'tranchee', to: 'Camille Martin', changes: 0 });
  });
  test('injection et relance citent les questions ouvertes du fil', () => {
    const s = foldValidations([expectEv('Q1'), expectEv('Q2'), answer('Q1', NOW + H)], [w0()], NOW + H);
    const open = openQuestions(s, { chatId: '19:abc' });
    expect(open.map((i) => i.q)).toEqual(['Q2']);
    expect(openQuestions(s, { chatId: '19:autre' })).toEqual([]);
    expect(injectionText(w0(), [R1], 'node tw.ts', open)).toContain('Questions attendues dans ce fil (reprends ces ids) : Q2 « question Q2 »');
    expect(reminderQuestions(open)).toContain('Q2 « question Q2 »');
    expect(reminderQuestions([])).toBe('');
  });
  test('commande expect : enregistrée et rattachée au fil', () => {
    const root = mkdtempSync(join(tmpdir(), 'tv-')), dir = join(root, 'teams-waits');
    try {
      mkdirSync(dir, { recursive: true }); saveWait(dir, w0());
      const [code, out] = validationCommand(dir, ['expect', '--q', 'Q1', '--question', 'On sort le client ?', '--to', 'Camille Martin'], { CLAUDE_CODE_SESSION_ID: SID }, NOW + 60_000, 'e1');
      expect(code).toBe(0); expect(out).toContain('rattachée au fil');
      expect(JSON.parse(readFileSync(join(dir, '_summary.json'), 'utf8')).validations[SID]).toMatchObject({ expected: 1, items: [{ q: 'Q1', state: 'attendue', chatId: '19:abc' }] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('recopie sur le ticket', () => {
  const PAT = 'TCK-(\\d{6})';
  const ans = (evt: string, extra: Partial<ValEvent> = {}): ValEvent => ({ v: 1, evt, kind: 'answer', at: NOW, sessionId: SID, q: 'Q1', question: 'On sort <le> client ?', decision: 'valide-reserve', reserve: 'pas avant lundi', validator: 'Camille Martin', channel: 'teams', evidence: { chatId: '19:abc', messageId: R1.id, at: NOW - 60_000 }, quote: 'oui & d’accord', scope: { hd: null }, recordedBy: 'session', ...extra });

  test('cible : seulement le ticket que la validation NOMME (jamais celui déduit de la session)', () => {
    expect(exportTarget(ans('e', { scope: { hd: 'TCK-222222' } }), PAT)).toEqual({ ticket: 'TCK-222222', id: '222222' });
    expect(exportTarget(ans('e'), PAT)).toEqual({ skip: 'sans --hd' });
    expect(exportTarget(ans('e', { scope: { hd: 'AUTRE-1' } }), PAT)).toEqual({ skip: 'ticket non reconnu' });
    expect(exportTarget(ans('e', { scope: { hd: 'TCK-222222' } }), '(')).toEqual({ skip: 'motif de ticket invalide' });
  });
  test('note : échappée, référencée, sans mention', () => {
    const h = validationNoteHtml(ans('abc-123'));
    expect(h).toContain('Q1 : validé sous réserve');
    expect(h).toContain('On sort &lt;le&gt; client ?');
    expect(h).toContain('« oui &amp; d’accord »');
    expect(h).toContain('Réserve</strong> : pas avant lundi');
    expect(h).toContain('réf. validation abc-123');
    expect(h).not.toContain('data-mention-id');
    expect(validationNoteHtml(ans('x', { channel: 'relayed', evidence: null }))).toContain('rapportée par Alex, sans écrit');
  });

  describe('passe', () => {
    let root = '', dir = '';
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'tx-')); dir = join(root, 'teams-waits'); mkdirSync(join(root, 'session-tags'), { recursive: true }); });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });
    const tags = (...hd: string[]) => writeFileSync(join(root, 'session-tags', `${SID}.json`), JSON.stringify({ tags: hd.map((v) => ({ axis: 'hd', v, src: 'prompt' })) }));
    const named = (evt: string, extra: Partial<ValEvent> = {}) => ans(evt, { scope: { hd: 'TCK-111111' }, ...extra });
    const cfg = { command: ['tool', 'note'], ticketPattern: PAT };

    test('une note par décision, jamais deux ; l’état remonte dans le résumé', () => {
      appendValEvent(validationsDir(dir), named('e1'));
      const calls: string[][] = [];
      const exec = (a: string[]) => { calls.push(a); expect(readFileSync(a[3]!, 'utf8')).toContain('réf. validation e1'); return { code: 0, out: 'POSTED: TCK-111111 interaction=9\n' }; };
      expect(runExports(dir, cfg, NOW + 1000, false, exec)).toMatchObject({ posted: 1, failed: 0 });
      expect(calls[0]!.slice(0, 3)).toEqual(['tool', 'note', '111111']);
      expect(calls[0]!.slice(4)).toEqual(['--evt', 'e1']);
      expect(runExports(dir, cfg, NOW + 2000, false, exec).posted).toBe(0);
      expect(calls).toHaveLength(1);
      expect(validationSummaries(validationsDir(dir), [], NOW)[SID]!.items[0]!.exported).toBe('ok');
    });
    test('sans --hd : jamais recopiée, même si la session porte un seul ticket ; réenregistrée avec --hd, recopiée', () => {
      tags('TCK-333333'); appendValEvent(validationsDir(dir), ans('e1'));
      let n = 0; const exec = () => { n++; return { code: 0, out: 'POSTED' }; };
      expect(runExports(dir, cfg, NOW + 1000, false, exec)).toMatchObject({ posted: 0, skipped: 1 });
      expect(n).toBe(0);
      expect(validationSummaries(validationsDir(dir), [], NOW)[SID]!.items[0]!.exported).toBe('skip:sans --hd');
      appendValEvent(validationsDir(dir), named('e2', { at: NOW + 1500 }));
      expect(runExports(dir, cfg, NOW + 2000, false, exec)).toMatchObject({ posted: 1 });
      expect(validationSummaries(validationsDir(dir), [], NOW + 2000)[SID]!.items[0]!.exported).toBe('ok');
    });
    test('échec : réessayé après 10 min, abandonné après 3 essais ; essai à blanc sans trace', () => {
      appendValEvent(validationsDir(dir), named('e1'));
      let n = 0; const exec = () => { n++; return { code: 1, out: 'boom\n[outil] refusé' }; };
      expect(runExports(dir, cfg, NOW, true, exec)).toMatchObject({ posted: 0, failed: 0 });
      expect(n).toBe(1);
      expect(validationSummaries(validationsDir(dir), [], NOW)[SID]!.items[0]!.exported).toBeUndefined();
      expect(runExports(dir, cfg, NOW, false, exec)).toMatchObject({ failed: 1, errors: ['recopie TCK-111111 : [outil] refusé'] });
      runExports(dir, cfg, NOW + 60_000, false, exec); expect(n).toBe(2);           // trop tôt
      runExports(dir, cfg, NOW + 11 * 60_000, false, exec); runExports(dir, cfg, NOW + 22 * 60_000, false, exec); runExports(dir, cfg, NOW + 33 * 60_000, false, exec);
      expect(n).toBe(4);
      expect(validationSummaries(validationsDir(dir), [], NOW)[SID]!.items[0]!.exported).toBe('echec');
    });
    test('décision de plus de 7 jours : pas recopiée', () => {
      appendValEvent(validationsDir(dir), named('old', { at: NOW - 8 * 86_400_000 }));
      let n = 0; runExports(dir, cfg, NOW, false, () => { n++; return { code: 0, out: 'POSTED' }; });
      expect(n).toBe(0);
    });
  });
});
