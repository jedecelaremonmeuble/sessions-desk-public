// Fonctions PURES d'app.js dont les tests étaient dans la suite PowerShell historique (absente de ce dépôt) : quota,
// attentes Teams, runs du lanceur, en-tête d'une demande, livraison refusée, analyse markdown. Extraites du fichier
// servi — la page n'est pas un module — et exécutées seules ; T rend le français (setup-page-globals.ts).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const js = readFileSync(fileURLToPath(new URL('../../page/app.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
function grab(name: string): string {
  const m = js.match(new RegExp('\\nfunction ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n'));
  if (!m) throw new Error(name + ' introuvable dans la page');
  return m[0];
}
/** Une constante de la page, sur une ou plusieurs lignes, jusqu'au « ; » de fin de ligne. */
function grabConst(name: string): string {
  const m = js.match(new RegExp('\\nconst ' + name + ' = [\\s\\S]*?;\\n'));
  if (!m) throw new Error(name + ' introuvable dans la page');
  return m[0];
}
type Fn = (...a: any[]) => any;
function load(code: string, names: string[]): Record<string, Fn> {
  return new Function(code + '\nreturn { ' + names.join(', ') + ' };')() as Record<string, Fn>;
}

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
// Vendredi 20 novembre 2026, 10:00 à Paris (UTC+1).
const NOW = Date.UTC(2026, 10, 20, 9, 0);

// ───── Quota des comptes Claude ─────
const quota = load(
  'let QUOTA = null; const data = null; const ui = () => (QUOTA ? { quota: QUOTA } : {});\n'
  + 'const setQuota = q => { QUOTA = q; };\n' + grabConst('qLevel') + grabConst('WEEK') + grab('quotaView'),
  ['quotaView', 'setQuota']);
const quotaView = quota.quotaView!;

describe('quotaView', () => {
  const base = { alias: 'perso', active: true, status: 'ok', measuredAt: NOW - MIN, weeklyResetsAt: NOW + 3.5 * DAY };

  test('semaine à mi-chemin : part écoulée, rythme, budget par jour et rythme récent', () => {
    const v = quotaView({ ...base, weeklyPct: 50, weeklyProjectedPct: 64 }, NOW);
    expect(v).toMatchObject({ alias: 'perso', active: true, ok: true, expired: false, stale: false, pct: 50, reset: NOW + 3.5 * DAY,
      elapsed: 50, pace: 0, level: 'busy', fullAt: null, fiveHour: null });
    expect(v.budgetPerDay).toBeCloseTo(50 / 3.5, 6);
    expect(v.recentPerDay).toBeCloseTo(4, 6);
    expect(v.age).toBe(MIN);
  });

  test('consommé plus vite qu’un rythme régulier : écart positif', () => {
    expect(quotaView({ ...base, weeklyPct: 70 }, NOW).pace).toBe(20);
  });

  test('projection sous le relevé : pas de rythme récent', () => {
    expect(quotaView({ ...base, weeklyPct: 50, weeklyProjectedPct: 40 }, NOW).recentPerDay).toBeUndefined();
  });

  test('seuils par défaut 75 / 90, ou ceux du poste (ui.quota)', () => {
    expect(quotaView({ ...base, weeklyPct: 80 }, NOW).level).toBe('ask');
    expect(quotaView({ ...base, weeklyPct: 95 }, NOW).level).toBe('waiting');
    quota.setQuota!({ warn: 40, alert: 60 });
    try { expect(quotaView({ ...base, weeklyPct: 50 }, NOW).level).toBe('ask'); } finally { quota.setQuota!(null); }
  });

  test('remise passée : le relevé ne vaut plus', () => {
    const v = quotaView({ ...base, weeklyPct: 50, weeklyResetsAt: NOW - 1, weeklyFullAt: NOW + DAY }, NOW);
    expect(v).toMatchObject({ expired: true, stale: true, level: 'idle', fullAt: null });
    expect(v.reset).toBeUndefined();
    expect(v.pace).toBeUndefined();
  });

  test('relevé de plus de 30 min, ou statut autre que ok : périmé', () => {
    expect(quotaView({ ...base, weeklyPct: 50, measuredAt: NOW - 31 * MIN }, NOW).stale).toBe(true);
    expect(quotaView({ ...base, weeklyPct: 50, measuredAt: NOW - 29 * MIN }, NOW).stale).toBe(false);
    expect(quotaView({ ...base, weeklyPct: 50, status: 'rejected' }, NOW).stale).toBe(true);
  });

  test('sans pourcentage : rien à montrer', () => {
    expect(quotaView({ ...base }, NOW)).toMatchObject({ ok: false, level: 'idle' });
  });

  test('plein avant la remise : signalé, même sous le seuil', () => {
    const v = quotaView({ ...base, weeklyPct: 50, weeklyFullAt: NOW + DAY }, NOW);
    expect(v).toMatchObject({ fullAt: NOW + DAY, level: 'ask' });
    expect(quotaView({ ...base, weeklyPct: 50, weeklyFullAt: NOW + 4 * DAY }, NOW).fullAt).toBeNull();   // après la remise
    expect(quotaView({ ...base, weeklyPct: 50, weeklyFullAt: NOW - 1 }, NOW).fullAt).toBeNull();          // déjà passé
  });

  test('limites par modèle et fenêtre de 5 h', () => {
    const v = quotaView({ ...base, weeklyPct: 50, fiveHourPct: 12, fiveHourResetsAt: NOW + HOUR,
      limits: [{ model: 'Fable', pct: 80, resetsAt: NOW + DAY }, { model: 'Sonnet', pct: 10, resetsAt: NOW - 1 }, { model: 'Haiku', pct: null }, { pct: 5 }] }, NOW);
    expect(v.models).toHaveLength(2);
    expect(v.models[0]).toMatchObject({ name: 'Fable', pct: 80, reset: NOW + DAY, level: 'ask' });
    expect(v.models[0].elapsed).toBeCloseTo(600 / 7, 6);
    expect(v.models[1]).toMatchObject({ name: 'Sonnet', reset: null, elapsed: 50, level: 'busy' });   // remise passée : repère global
    expect(v.fiveHour).toEqual({ pct: 12, reset: NOW + HOUR });
  });
});

// ───── Attentes Teams ─────
const teams = load(grab('teamsWaitLine') + grab('teamsHeld'), ['teamsWaitLine', 'teamsHeld']);
const teamsWaitLine = teams.teamsWaitLine!, teamsHeld = teams.teamsHeld!;

describe('teamsWaitLine', () => {
  const open = { status: 'open', chatLabel: 'Alex', sentAt: NOW - 90 * MIN };

  test('réponse reçue : qui, depuis quand, transmise ou non', () => {
    const r = { status: 'replied', chatLabel: 'Alex', replyFrom: 'Alex Martin', repliedAt: NOW - 5 * MIN };
    expect(teamsWaitLine(r, NOW, true)).toBe('💬 Alex Martin a répondu il y a 5 min · transmission en cours');
    expect(teamsWaitLine({ ...r, lastError: 'session occupée' }, NOW, true)).toBe('💬 Alex Martin a répondu il y a 5 min · pas encore transmise (session occupée)');
    expect(teamsWaitLine({ ...r, replyFrom: null }, NOW, true)).toBe('💬 Alex a répondu il y a 5 min · transmission en cours');
  });

  test('attente ouverte : durée en minutes, heures puis jours, depuis le premier envoi', () => {
    expect(teamsWaitLine({ ...open, sentAt: NOW - 59 * MIN }, NOW, true)).toBe('⏳ attend Alex depuis 59 min');
    expect(teamsWaitLine(open, NOW, true)).toBe('⏳ attend Alex depuis 1 h');
    expect(teamsWaitLine({ ...open, sentAt: NOW - 3 * DAY }, NOW, true)).toBe('⏳ attend Alex depuis 3 j');
    expect(teamsWaitLine({ ...open, firstSentAt: NOW - 5 * HOUR }, NOW, true)).toBe('⏳ attend Alex depuis 5 h');
    expect(teamsWaitLine({ status: 'open', sentAt: NOW - 2 * MIN }, NOW, true)).toBe('⏳ attend le chat Teams depuis 2 min');
  });

  test('relances faites et prochaine relance, à l’heure de Paris', () => {
    const w = { ...open, reminders: 2, next: { kind: 'remind', at: NOW + 30 * MIN } };
    expect(teamsWaitLine(w, NOW, true)).toBe('⏳ attend Alex depuis 1 h · 2 relances faites · relance à 10:30');
    expect(teamsWaitLine({ ...w, reminders: 1 }, NOW, true)).toBe('⏳ attend Alex depuis 1 h · 1 relance faite · relance à 10:30');
    // Relances autonomes éteintes : la prochaine n'est pas annoncée.
    expect(teamsWaitLine(w, NOW, false)).toBe('⏳ attend Alex depuis 1 h · 2 relances faites');
  });

  test('prochaine alerte un autre jour : le jour est donné', () => {
    const line = teamsWaitLine({ ...open, next: { kind: 'alert', at: NOW + DAY } }, NOW, false);
    expect(line).toMatch(/^⏳ attend Alex depuis 1 h · alerte à sam\.? 10:00$/);
  });

  test('alerte envoyée : la ligne le dit, avec les relances restées sans réponse', () => {
    expect(teamsWaitLine({ ...open, sentAt: NOW - 2 * DAY, reminders: 1, alertedAt: NOW - HOUR }, NOW, true)).toBe('🔔 Alex n’a pas répondu depuis 2 j malgré 1 relance');
    expect(teamsWaitLine({ ...open, sentAt: NOW - 2 * DAY, reminders: 3, alertedAt: NOW - HOUR }, NOW, true)).toBe('🔔 Alex n’a pas répondu depuis 2 j malgré 3 relances');
    expect(teamsWaitLine({ ...open, alertedAt: NOW - MIN }, NOW, true)).toBe('🔔 Alex n’a pas répondu depuis 1 h');
  });

  test('erreur du veilleur : ajoutée en fin de ligne', () => {
    expect(teamsWaitLine({ ...open, lastError: 'jeton expiré' }, NOW, true)).toBe('⏳ attend Alex depuis 1 h (jeton expiré)');
  });
});

describe('teamsHeld', () => {
  test('rangée dans « Attente Teams » : session au repos avec une attente ouverte', () => {
    for (const s of ['done', 'idle', 'closed']) expect(teamsHeld(s, [{ status: 'replied' }, { status: 'open' }])).toBe(true);
  });
  test('reste dans son groupe : au travail, attend une décision, réponse arrivée, aucune attente', () => {
    for (const s of ['busy', 'ask', 'waiting']) expect(teamsHeld(s, [{ status: 'open' }])).toBe(false);
    expect(teamsHeld('done', [{ status: 'replied' }])).toBe(false);
    expect(teamsHeld('done', [])).toBe(false);
    expect(teamsHeld('done', null)).toBe(false);
  });
});

// ───── Runs du lanceur dans la liste ─────
const runs = load(grab('launcherGroup') + grab('runsByHd'), ['launcherGroup', 'runsByHd']);
const launcherGroup = runs.launcherGroup!, runsByHd = runs.runsByHd!;
const SINCE = NOW - 10 * HOUR;
// `running` est toujours un booléen dans ce que rend le serveur (launcher.ts) : le tri en dépend.
const run = (o: Record<string, unknown>) => ({ hd: '111111', phase: 'dev', dir: 'r-' + Math.random().toString(36).slice(2), at: NOW - HOUR, running: false, ...o });

describe('launcherGroup', () => {
  test('runs du jour et runs en cours seulement', () => {
    const { items } = launcherGroup([run({ at: SINCE - 1 }), run({ at: SINCE - 1, running: true }), run({ at: SINCE })], [], [], SINCE);
    expect(items).toHaveLength(2);
  });

  test('couleur : en cours, en échec, à valider, livré, à reprendre', () => {
    const look = (r: Record<string, unknown>, waiting: unknown[] = []) => launcherGroup([run(r)], waiting, [], SINCE).items[0].look;
    expect(look({ running: true, outcome: 'failed' })).toBe('busy');
    expect(look({ outcome: 'timeout' })).toBe('waiting');
    expect(look({ outcome: 'posted', verdict: 'refus' })).toBe('waiting');
    expect(look({ outcome: 'posted' }, [{ hd: 111111, stage: 'dev-failed' }])).toBe('waiting');
    expect(look({ outcome: 'pr-open' }, [{ hd: '111111', stage: 'pr-awaiting-approval' }])).toBe('ask');
    expect(look({ outcome: 'merged' })).toBe('done');
    expect(look({ outcome: 'merged', verdict: 'a-reprendre' })).toBe('idle');
    expect(look({ outcome: 'skipped' })).toBe('idle');
  });

  test('l’attente de la demande ne vaut que pour son dernier run', () => {
    const old = run({ at: NOW - 3 * HOUR, outcome: 'posted' }), last = run({ at: NOW - HOUR, outcome: 'pr-open' });
    const { items } = launcherGroup([old, last], [{ hd: '111111', stage: 'pr-awaiting-approval', prNumber: 42, prUrl: 'https://example.com/pr/42' }], [], SINCE);
    const byRun = new Map(items.map((i: { run: unknown }) => [i.run, i]));
    expect(byRun.get(last)).toMatchObject({ look: 'ask', pr: 42, prUrl: 'https://example.com/pr/42' });
    expect(byRun.get(old)).toMatchObject({ wait: null, pr: null });
  });

  test('session headless du run : absorbée, et ses données passent avant celles du run', () => {
    const open = [{ headless: true, pid: 10, sessionId: 's-1', model: 'opus', tokens: 1200, reply: 'fini', cwd: 'C:\\work' },
      { headless: false, pid: 11, sessionId: 's-2' }];
    const { items, absorbed } = launcherGroup([run({ pid: 10, running: true, model: 'haiku' }), run({ pid: 11 })], [], open, SINCE);
    expect([...absorbed]).toEqual(['s-1']);
    expect(items[0]).toMatchObject({ sessionId: 's-1', model: 'opus', tokens: 1200, reply: 'fini', cwd: 'C:\\work', pid: 10, outcome: 'en cours' });
    expect(items[1]).toMatchObject({ sessionId: null, cwd: null });   // une session interactive n'est pas celle du run
  });

  test('retrouvée aussi par l’id de session du run en cours', () => {
    const { absorbed, items } = launcherGroup([run({ running: true, liveSessionId: 's-9' })], [], [{ headless: true, sessionId: 's-9' }], SINCE);
    expect([...absorbed]).toEqual(['s-9']);
    expect(items[0].sessionId).toBe('s-9');
  });

  test('titre, résultat, fin du run et run scripté', () => {
    const [it] = launcherGroup([run({ phase: 'merge', title: 'Corriger l’export', outcome: 'merged', verdict: 'ok', minutes: 2, at: NOW - HOUR })], [], [], SINCE).items;
    expect(it).toMatchObject({ kind: 'run', title: 'HD-111111 · merge — Corriger l’export', outcome: 'merged · ok', since: NOW - HOUR + 2 * MIN, scripted: true });
    expect(launcherGroup([run({ phase: 'merge', sessionId: 's-3' })], [], [], SINCE).items[0].scripted).toBe(false);
    expect(launcherGroup([run({ phase: 'dev' })], [], [], SINCE).items[0].scripted).toBe(false);
  });

  test('ordre : en cours d’abord, puis le plus récent', () => {
    const a = run({ at: NOW - 3 * HOUR, running: true }), b = run({ at: NOW - HOUR }), c = run({ at: NOW - 2 * HOUR });
    expect(launcherGroup([b, c, a], [], [], SINCE).items.map((i: { run: unknown }) => i.run)).toEqual([a, b, c]);
  });

  test('aucune donnée : liste vide', () => {
    const { items, absorbed } = launcherGroup(null, null, null, SINCE);
    expect(items).toEqual([]);
    expect(absorbed.size).toBe(0);
  });
});

describe('runsByHd', () => {
  const item = (hd: string, at: number, o: Record<string, unknown> = {}, r: Record<string, unknown> = {}) =>
    ({ key: 'run:' + at, at, pr: null, prUrl: null, ...o, run: { hd, phase: 'dev', running: false, costUsd: null, ...r } });

  test('une ligne par demande : tête = run en cours, sinon le plus récent', () => {
    const out = runsByHd([item('1', NOW - 3 * HOUR, {}, { phase: 'diagnostic' }), item('1', NOW - HOUR, {}, { phase: 'dev', running: true }),
      item('1', NOW - 2 * HOUR, {}, { phase: 'relecture' }), item('2', NOW - 30 * MIN)]);
    expect(out.map((o: { key: string }) => o.key)).toEqual(['hd:1', 'hd:2']);
    expect(out[0]).toMatchObject({ runCount: 3, phases: ['diagnostic', 'relecture', 'dev'], at: NOW - HOUR });
    expect(out[0].runs.map((i: { at: number }) => i.at)).toEqual([NOW - HOUR, NOW - 2 * HOUR, NOW - 3 * HOUR]);
  });

  test('coût total arrondi au centime, absent sans aucun coût', () => {
    const out = runsByHd([item('1', NOW - HOUR, {}, { costUsd: 1.234 }), item('1', NOW - 2 * HOUR, {}, { costUsd: 2.1 }), item('1', NOW - 3 * HOUR), item('2', NOW)]);
    const by = new Map(out.map((o: { key: string }) => [o.key, o]));
    expect((by.get('hd:1') as { costTotal: number }).costTotal).toBe(3.33);
    expect((by.get('hd:2') as { costTotal: null }).costTotal).toBeNull();
  });

  test('PR : celle de la tête, sinon celle d’un autre run de la demande', () => {
    const [o] = runsByHd([item('1', NOW - HOUR), item('1', NOW - 2 * HOUR, { pr: 42, prUrl: 'https://example.com/pr/42' })]);
    expect(o).toMatchObject({ pr: 42, prUrl: 'https://example.com/pr/42' });
  });

  test('ordre : demande en cours d’abord, puis la plus récente', () => {
    const out = runsByHd([item('1', NOW - HOUR), item('2', NOW - 5 * HOUR, {}, { running: true }), item('3', NOW - 30 * MIN)]);
    expect(out.map((o: { key: string }) => o.key)).toEqual(['hd:2', 'hd:3', 'hd:1']);
    expect(runsByHd(null)).toEqual([]);
  });
});

// ───── En-tête d'une demande ─────
const hdParts = load(grabConst('HD_STATUS_FR') + grabConst('HD_KIND_FR') + grabConst('HD_PRIO_FR') + grab('hdParts'), ['hdParts']).hdParts!;

describe('hdParts', () => {
  test('les éléments présents, dans l’ordre, traduits', () => {
    const parts = hdParts({ kind: 'Bug', status: 'InProgress', requester: 'Alex Martin', createdAt: '2026-11-20T09:05:00', domain: 'Export',
      severity: 'S2', priority: 'High', assignee: 'Sam', clients: 3 });
    expect(parts).toHaveLength(9);
    expect(parts[0]).toBe('🐞 Bug');
    expect(parts[1]).toBe('En cours');
    expect(parts[2]).toBe('demandée par Alex Martin');
    expect(parts[3]).toMatch(/^le 20\/11 \d\d:05$/);   // heure du poste : la date sans fuseau est lue en UTC
    expect(parts.slice(4)).toEqual(['domaine Export', 'sévérité S2', 'priorité haute', 'assignée à Sam', '3 clients liés']);
  });

  test('valeur inconnue des tables : gardée telle quelle', () => {
    expect(hdParts({ kind: 'Question', status: 'Draft', priority: 'P0' })).toEqual(['Question', 'Draft', 'priorité P0']);
  });

  test('date avec fuseau, date illisible, un seul client, rien', () => {
    expect(hdParts({ createdAt: '2026-11-20T09:05:00+01:00' })[0]).toMatch(/^le 20\/11 \d\d:05$/);
    expect(hdParts({ createdAt: 'pas une date' })).toEqual([]);
    expect(hdParts({ clients: 1 })).toEqual(['1 client lié']);
    expect(hdParts({})).toEqual([]);
  });
});

// ───── Livraison refusée ─────
const delivery = load(grabConst('RESUME_WHAT') + grab('deliveryOrders') + grab('resumePrompt') + grab('diffHeadline'),
  ['deliveryOrders', 'resumePrompt', 'diffHeadline']);
const deliveryOrders = delivery.deliveryOrders!, resumePrompt = delivery.resumePrompt!, diffHeadline = delivery.diffHeadline!;

describe('deliveryOrders', () => {
  const list = ['merge', 'review', 'rework'];
  test('pas de refus, ou pas de livraison proposée : rien ne change', () => {
    expect(deliveryOrders(list, null)).toBe(list);
    const noMerge = ['review'];
    expect(deliveryOrders(noMerge, 'conflict')).toBe(noMerge);
  });
  test('commits ajoutés : relire puis livrer, ou reprendre en session', () => {
    expect(deliveryOrders(list, 'head-changed')).toEqual(['adopt', 'review', 'rework', 'session']);
  });
  test('panne technique : relancer, ou reprendre en session', () => {
    expect(deliveryOrders(list, 'technical')).toEqual(['retry', 'review', 'rework', 'session']);
  });
  test('conflit, doublon, autre refus : reprendre en session seulement', () => {
    for (const k of ['conflict', 'duplicate', 'autre']) expect(deliveryOrders(list, k)).toEqual(['session', 'review', 'rework']);
  });
});

describe('resumePrompt', () => {
  test('la PR, la demande, la raison nettoyée, la tâche et la règle du go', () => {
    const p = resumePrompt('111111', 42, 'conflict', 'livraison refusée —   conflit\n  sur   main');
    const parts = p.split('\n\n');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('La livraison automatique de la PR #42 (demande HD-111111) a été refusée par le lanceur : « conflit sur main ».');
    expect(parts[1]).toContain('résous le conflit avec la branche principale');
    expect(parts[2]).toBe('Ne merge rien sans mon go : montre-moi d’abord ce que tu as changé et le résultat des contrôles.');
  });
  test('sans raison, raison trop longue, nature inconnue', () => {
    expect(resumePrompt('111111', 42, 'technical', '').split('\n\n')[0]).toBe('La livraison automatique de la PR #42 (demande HD-111111) a été refusée par le lanceur.');
    expect(resumePrompt('111111', 42, 'technical', 'x'.repeat(800)).split('\n\n')[0]).toContain('« ' + 'x'.repeat(500) + ' »');
    expect(resumePrompt('111111', 42, 'inconnu', null).split('\n\n')[1]).toContain('comprends ce qui bloque');
  });
});

describe('diffHeadline', () => {
  test('diff illisible', () => {
    expect(diffHeadline(null)).toBe('⛔ diff illisible');
    expect(diffHeadline({ error: 'PR introuvable' })).toBe('⛔ PR introuvable');
  });
  test('PR plus ouverte', () => {
    expect(diffHeadline({ merged: true })).toBe('La PR n’est plus ouverte (mergée) : rien à livrer.');
    expect(diffHeadline({ state: 'closed' })).toBe('La PR n’est plus ouverte (fermée) : rien à livrer.');
  });
  test('rien de nouveau depuis les contrôles', () => {
    expect(diffHeadline({ changed: false })).toMatch(/^La PR porte de nouveau le commit contrôlé/);
  });
  test('commits ajoutés, ou PR réécrite : singulier et pluriel', () => {
    expect(diffHeadline({ changed: true, commits: [{}], files: [{}] })).toBe('Arrivé sur la PR après les contrôles du lanceur, lu par personne : 1 commit · 1 fichier.');
    expect(diffHeadline({ changed: true, rewritten: true, commits: [{}, {}], files: [{}, {}, {}] }))
      .toBe('⚠️ La PR a été réécrite (rebase ou force-push) depuis les contrôles : c’est TOUTE la PR qui est à relire — 2 commits · 3 fichiers.');
  });
});

// ───── Markdown des messages de Claude ─────
const md = load(grab('mdBoldEnd') + grab('mdInline') + grab('mdBlocks'), ['mdInline', 'mdBlocks']);
const mdInline = md.mdInline!, mdBlocks = md.mdBlocks!;
const t = (s: string) => ({ k: 't', t: s });

describe('mdInline', () => {
  test('gras, italique, barré, code', () => {
    expect(mdInline('a **b** c')).toEqual([t('a '), { k: 'b', c: [t('b')] }, t(' c')]);
    expect(mdInline('__b__')).toEqual([{ k: 'b', c: [t('b')] }]);
    expect(mdInline('*i* et _j_')).toEqual([{ k: 'i', c: [t('i')] }, t(' et '), { k: 'i', c: [t('j')] }]);
    expect(mdInline('~~x~~')).toEqual([{ k: 's', c: [t('x')] }]);
    expect(mdInline('**gras _et italique_**')).toEqual([{ k: 'b', c: [t('gras '), { k: 'i', c: [t('et italique')] }] }]);
  });

  test('gras et italique imbriqués, fermés ensemble', () => {
    expect(mdInline('**gras *italique***')).toEqual([{ k: 'b', c: [t('gras '), { k: 'i', c: [t('italique')] }] }]);
    expect(mdInline('*italique **gras***')).toEqual([{ k: 'i', c: [t('italique '), { k: 'b', c: [t('gras')] }] }]);
    expect(mdInline('***les deux***')).toEqual([{ k: 'b', c: [{ k: 'i', c: [t('les deux')] }] }]);
    expect(mdInline('a ***b*** c')).toEqual([t('a '), { k: 'b', c: [{ k: 'i', c: [t('b')] }] }, t(' c')]);
  });

  test('gras suivi d’une étoile seule, gras sans fermeture', () => {
    expect(mdInline('**gras***')).toEqual([{ k: 'b', c: [t('gras')] }, t('*')]);
    expect(mdInline('**a** et **b**')).toEqual([{ k: 'b', c: [t('a')] }, t(' et '), { k: 'b', c: [t('b')] }]);
    expect(mdInline('**pas fermé')).toEqual([t('**pas fermé')]);
    expect(mdInline('** pas du gras**')).toEqual([t('** pas du gras**')]);
  });

  test('texte plein d’étoiles jamais fermées : reste rapide', () => {
    // Une recherche de fermeture qui recopierait le reste du texte à chaque « ** » prendrait des dizaines de secondes ici.
    for (const s of ['**a '.repeat(4000), '*a **b '.repeat(3000), '**x* '.repeat(3000)]) {
      const t0 = performance.now();
      mdInline(s);
      expect(performance.now() - t0).toBeLessThan(2000);
    }
  });

  test('code : contenu brut, doubles accents graves, espaces de bord retirés', () => {
    expect(mdInline('`a **b**`')).toEqual([{ k: 'code', t: 'a **b**' }]);
    expect(mdInline('`` a`b ``')).toEqual([{ k: 'code', t: 'a`b' }]);
  });

  test('pas d’italique au milieu d’un mot ni autour d’une espace', () => {
    expect(mdInline('snake_case_name')).toEqual([t('snake_case_name')]);
    expect(mdInline('2 * 3 * 4')).toEqual([t('2 * 3 * 4')]);
  });

  test('caractères échappés', () => {
    expect(mdInline('\\*pas en italique\\*')).toEqual([t('*pas en italique*')]);
  });

  test('liens : http(s) seulement, URL nue sans la ponctuation finale', () => {
    expect(mdInline('[doc](https://example.com/a)')).toEqual([{ k: 'a', href: 'https://example.com/a', c: [t('doc')] }]);
    expect(mdInline('[x](javascript:alert(1))')).toEqual([t('[x](javascript:alert(1))')]);
    expect(mdInline('voir https://example.com/b.')).toEqual([t('voir '), { k: 'a', href: 'https://example.com/b', c: [t('https://example.com/b')] }, t('.')]);
    expect(mdInline('xhttps://example.com')).toEqual([t('xhttps://example.com')]);
  });
});

describe('mdBlocks', () => {
  test('titres, filet, paragraphe sur plusieurs lignes, fins de ligne Windows', () => {
    expect(mdBlocks('# Titre #\r\n\r\nligne 1\r\nligne 2\r\n\r\n---\r\n### Sous-titre')).toEqual([
      { k: 'h', lv: 1, in: [t('Titre')] },
      { k: 'p', in: [t('ligne 1\nligne 2')] },
      { k: 'hr' },
      { k: 'h', lv: 3, in: [t('Sous-titre')] },
    ]);
  });

  test('bloc de code : langage, contenu brut, clôture absente', () => {
    expect(mdBlocks('```ts\nconst a = **1**;\n\n```\napres')).toEqual([{ k: 'code', lang: 'ts', t: 'const a = **1**;\n' }, { k: 'p', in: [t('apres')] }]);
    expect(mdBlocks('~~~\nsans fin')).toEqual([{ k: 'code', lang: '', t: 'sans fin' }]);
  });

  test('tableau : en-tête, lignes, barre verticale échappée', () => {
    expect(mdBlocks('| a | b |\n|---|:--:|\n| 1 | x \\| y |\n\nfin')).toEqual([
      { k: 'table', head: [[t('a')], [t('b')]], rows: [[[t('1')], [t('x | y')]]] },
      { k: 'p', in: [t('fin')] },
    ]);
  });

  test('citation, imbriquée', () => {
    expect(mdBlocks('> un\n> > deux')).toEqual([{ k: 'quote', c: [{ k: 'p', in: [t('un')] }, { k: 'quote', c: [{ k: 'p', in: [t('deux')] }] }] }]);
  });

  test('listes : puces, numéros, niveaux, ligne de suite', () => {
    expect(mdBlocks('- a\n  suite\n  - b\n3. c\n\npara')).toEqual([
      { k: 'list', items: [{ lv: 0, o: null, in: [t('a\nsuite')] }, { lv: 1, o: null, in: [t('b')] }, { lv: 0, o: 3, in: [t('c')] }] },
      { k: 'p', in: [t('para')] },
    ]);
  });

  test('un paragraphe s’arrête au début d’un autre bloc', () => {
    expect(mdBlocks('texte\n## Titre')).toEqual([{ k: 'p', in: [t('texte')] }, { k: 'h', lv: 2, in: [t('Titre')] }]);
  });

  test('rien, ou null', () => {
    expect(mdBlocks('')).toEqual([]);
    expect(mdBlocks(null)).toEqual([]);
    expect(mdBlocks('\n  \n')).toEqual([]);
  });
});
