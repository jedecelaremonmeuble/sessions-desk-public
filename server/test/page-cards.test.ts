// Panneau des cartes de questions dans la page : fonctions PURES d'app.js (cardRuns, withCards, cardForm, cardAnswers),
// extraites du fichier servi — la page n'est pas un module.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const candidates = ['../../page/app.js', '../../page/app.js'].map((p) => fileURLToPath(new URL(p, import.meta.url)));
const js = readFileSync(candidates.find((p) => existsSync(p))!, 'utf8').replace(/\r\n/g, '\n');
function grab(name: string): string {
  const m = js.match(new RegExp('\\nfunction ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n'));
  if (!m) throw new Error(name + ' introuvable dans la page');
  return m[0];
}
const cardFr = js.match(/\nconst CARD_FR = \{.*\};\n/)![0];
type Fns = { cardRuns: (r: unknown[], c: unknown[], s: number) => { hd: string; at: number }[]; withCards: (i: unknown[], c: unknown[]) => Record<string, unknown>[];
  cardForm: (c: unknown) => { title: string; neighbours: number; questions: { id: string; open: boolean; multi: boolean; required: boolean; options: { id: string; recommended: boolean }[] }[] };
  cardAnswers: (c: unknown, p: unknown, o: unknown) => { answers?: unknown[]; missing?: string[]; error?: string };
  cardAnsweredText: (hd: string, missing: string[], j: unknown) => string };
const fns = new Function(cardFr + ['cardRuns', 'withCards', 'cardForm', 'cardAnswers', 'cardAnsweredText'].map(grab).join('\n')
  + '\nreturn { cardRuns, withCards, cardForm, cardAnswers, cardAnsweredText };')() as Fns;

describe('après « Envoyer les réponses »', () => {
  test('cardAnsweredText : ce que l’orchestrateur a fait de la réponse, sinon la phrase d’avant', () => {
    expect(fns.cardAnsweredText('42', [], { ok: true, launcher: 'lanceur : correctif en file (carte 7)' }))
      .toBe('✅ Réponse enregistrée dans HD-42. Lanceur : correctif en file (carte 7).');
    expect(fns.cardAnsweredText('42', ['Date'], { ok: true })).toBe('✅ Réponse enregistrée dans HD-42 — sans réponse : Date. Le lanceur la lit à sa prochaine passe.');
    expect(fns.cardAnsweredText('42', [], { ok: true, launcher: '  ' })).toBe('✅ Réponse enregistrée dans HD-42. Le lanceur la lit à sa prochaine passe.');
  });
});

const choice = { id: 'q', header: 'Critère', question: 'Lequel ?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', description: 'le bon', recommended: true }] };
const open = { id: 'date', header: 'Date', question: 'Quand ?' };
const decision = { id: 'decision', header: 'Développement', question: 'Lancer ?', options: [{ id: 'go', label: 'Lancer', recommended: true }, { id: 'plus-tard', label: 'Pas maintenant' }, { id: 'non', label: 'Ne pas faire' }] };
const arbitrage = { id: 7, hd: '42', kind: 'arbitrage', flavor: 'arbitrage', neighbours: 1, questions: [choice, open] };
const validation = { id: 9, hd: '43', kind: 'validation', flavor: 'validation', questions: [choice, decision] };

describe('liste : une demande dont une carte attend', () => {
  test('cardRuns : le dernier run d’avant minuit d’une demande à carte, jamais un run du jour ni en cours', () => {
    const runs = [{ hd: '42', at: 10 }, { hd: '42', at: 20 }, { hd: '43', at: 150 }, { hd: '43', at: 30 }, { hd: '44', at: 5 }, { hd: '45', at: 5, running: true }];
    const cards = [{ hd: '42' }, { hd: 43 }, { hd: '45' }];
    expect(fns.cardRuns(runs, cards, 100)).toEqual([{ hd: '42', at: 20 }]);
    expect(fns.cardRuns(runs, [], 100)).toEqual([]);
  });
  test('withCards : cartes posées sur la ligne, couleur « attend ta décision » sauf run en cours', () => {
    const items = [{ key: 'hd:42', look: 'done', run: { hd: '42', running: false } }, { key: 'hd:43', look: 'busy', run: { hd: 43, running: true } }, { key: 'hd:44', look: 'idle', run: { hd: '44' } }];
    const out = fns.withCards(items, [arbitrage, validation, { ...arbitrage, id: 8 }]);
    expect(out.map((i) => [i.look, ((i.cards as unknown[]) || []).length])).toEqual([['ask', 2], ['busy', 1], ['idle', 0]]);
    expect(out[2]).toBe(items[2]);
  });
});

describe('cardForm : ce que le panneau affiche', () => {
  test('recommandée en premier, question ouverte, choix multiple, titre selon la carte', () => {
    const f = fns.cardForm({ ...arbitrage, questions: [choice, open, { ...choice, id: 'm', multiSelect: true }] });
    expect(f.title).toContain('⚖️'); expect(f.neighbours).toBe(1);
    expect(f.questions[0]!.options.map((o) => o.id)).toEqual(['b', 'a']);
    expect(f.questions.map((q) => [q.open, q.multi, q.required])).toEqual([[false, false, false], [true, false, false], [false, true, false]]);
    expect(fns.cardForm(validation).questions[1]!.required).toBe(true);
    expect(fns.cardForm({ ...validation, flavor: 'cadrage' }).title).toContain('📐');
    expect(fns.cardForm({ id: 1, kind: 'arbitrage' }).questions).toEqual([]);
  });
});

describe('cardAnswers : ce qui part', () => {
  test('choix + texte libre ; les questions vides sont listées, pas envoyées', () => {
    expect(fns.cardAnswers(arbitrage, { q: ['b'] }, { date: ' 27/11 ' })).toEqual({ answers: [{ questionId: 'q', selected: ['b'], other: null }, { questionId: 'date', selected: [], other: '27/11' }], missing: [] });
    expect(fns.cardAnswers(arbitrage, { q: ['a'] }, {})).toEqual({ answers: [{ questionId: 'q', selected: ['a'], other: null }], missing: ['Date'] });
  });
  test('option inconnue écartée, une seule option hors choix multiple, rien ⇒ refus', () => {
    expect(fns.cardAnswers(arbitrage, { q: ['zzz'] }, {}).error).toContain('au moins une question');
    expect(fns.cardAnswers(arbitrage, { q: ['a', 'b'] }, {}).answers).toEqual([{ questionId: 'q', selected: ['a'], other: null }]);
    const multi = { ...arbitrage, questions: [{ ...choice, multiSelect: true }] };
    expect(fns.cardAnswers(multi, { q: ['a', 'b'] }, {}).answers).toEqual([{ questionId: 'q', selected: ['a', 'b'], other: null }]);
    expect(fns.cardAnswers(arbitrage, {}, { date: 'x'.repeat(2001) }).error).toContain('2 000');
  });
  test('carte ✅ : décision obligatoire, motif exigé pour « Ne pas faire » (pas pour 📐 / 📝)', () => {
    expect(fns.cardAnswers(validation, { q: ['a'] }, {}).error).toContain('Choisis la décision');
    expect(fns.cardAnswers(validation, { decision: ['go'] }, { decision: 'avec le lot 2' }).answers).toEqual([{ questionId: 'decision', selected: ['go'], other: 'avec le lot 2' }]);
    expect(fns.cardAnswers(validation, { decision: ['non'] }, {}).error).toContain('motif');
    expect(fns.cardAnswers(validation, { decision: ['non'] }, { decision: 'doublon' }).error).toBeUndefined();
    expect(fns.cardAnswers({ ...validation, flavor: 'cadrage' }, { decision: ['non'] }, {}).error).toBeUndefined();
  });
});

describe('la demande ouverte ne quitte pas la liste sous l’utilisateur', () => {
  const keep = new Function(grab('keepSelectedRun') + '\nreturn keepSelectedRun;')() as
    (items: Record<string, unknown>[], held: Record<string, unknown> | null, sel: string | null) => { items: Record<string, unknown>[]; held: Record<string, unknown> | null };
  const old = { key: 'hd:42', run: { hd: '42', running: false }, look: 'ask', cards: [arbitrage] };
  const other = { key: 'hd:7', run: { hd: '7', running: false }, look: 'done' };

  test('présente dans la liste : retenue telle quelle, la liste ne change pas', () => {
    const r = keep([old, other], null, 'hd:42');
    expect(r.items).toEqual([old, other]);
    expect(r.held).toBe(old);
  });
  test('carte répondue (la demande d’avant minuit sort de la liste) : la dernière copie reste, sans ses cartes', () => {
    const r = keep([other], old, 'hd:42');
    expect(r.items.map((i) => i.key)).toEqual(['hd:7', 'hd:42']);
    expect(r.items[1]!.cards).toBeUndefined();
    expect(r.items[1]!.look).toBe('idle');
    expect(keep([other], r.held, 'hd:42').items).toHaveLength(2);   // relectures suivantes : toujours là
  });
  test('le run suivant arrive : c’est lui qui est affiché', () => {
    const go = { key: 'hd:42', run: { hd: '42', running: true }, look: 'busy' };
    expect(keep([go, other], old, 'hd:42')).toEqual({ items: [go, other], held: go });
  });
  test('autre sélection, session ou rien : rien n’est gardé', () => {
    expect(keep([other], old, 'hd:7')).toEqual({ items: [other], held: other });
    expect(keep([other], old, 'abc-session')).toEqual({ items: [other], held: null });
    expect(keep([other], old, null)).toEqual({ items: [other], held: null });
  });
});
