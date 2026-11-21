// Tâches programmées par la session (src/scheduled.ts) : ce qui attend encore, d'après le transcript.
import { mkdtempSync, appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { nextCronFire, pendingSchedules, ScheduleScan } from '../src/scheduled.ts';

const H = 3600 * 1000;
const NOW = Date.parse('2026-11-21T10:00:00.000Z');
const iso = (t: number): string => new Date(t).toISOString();
let n = 0;
const use = (name: string, input: Record<string, unknown>, at = NOW - H): { id: string; line: string } => {
  const id = 'toolu_' + ++n;
  return { id, line: JSON.stringify({ parentUuid: 'p', isSidechain: false, type: 'assistant', timestamp: iso(at), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }) };
};
const res = (id: string, toolUseResult: Record<string, unknown>, text = 'ok', at = NOW - H): string =>
  JSON.stringify({ parentUuid: 'p', isSidechain: false, type: 'user', timestamp: iso(at), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }, toolUseResult });
const cron = (cronExpr: string, r: Record<string, unknown>, prompt = 'opération de nuit sur le serveur de test', at = NOW - H): string[] => {
  const u = use('CronCreate', { cron: cronExpr, recurring: r.recurring === true, prompt }, at);
  return [u.line, res(u.id, { humanSchedule: cronExpr, recurring: false, durable: false, ...r }, 'Scheduled one-shot task ' + String(r.id), at)];
};
const del = (id: string): string[] => { const u = use('CronDelete', { id }); return [u.line, res(u.id, { id }, 'Cancelled job ' + id + '.')]; };
const fire = (taskId: string, at: number): string => JSON.stringify({ parentUuid: 'p', isSidechain: false, type: 'system', subtype: 'scheduled_task_fire', timestamp: iso(at), taskId });
const TONIGHT = Date.parse('2026-11-22T01:13:00.000Z');

describe('pendingSchedules : CronCreate', () => {
  test('une tâche « une fois » programmée pour cette nuit est attendue, avec son heure et sa consigne', () => {
    const j = pendingSchedules(cron('13 2 22 11 *', { id: 'aaaa1111', nextFireAt: TONIGHT }), NOW);
    expect(j).toEqual([{ id: 'aaaa1111', kind: 'cron', at: TONIGHT, cron: '13 2 22 11 *', recurring: false, durable: false, prompt: 'opération de nuit sur le serveur de test', since: NOW - H }]);
  });
  test('annulée puis reprogrammée : une seule tâche, la nouvelle', () => {
    const lines = [...cron('13 2 22 11 *', { id: 'aaaa1111', nextFireAt: TONIGHT }), ...del('aaaa1111'), ...cron('13 2 22 11 *', { id: 'bbbb2222', nextFireAt: TONIGHT })];
    expect(pendingSchedules(lines, NOW).map((j) => j.id)).toEqual(['bbbb2222']);
  });
  test('déclenchée : une tâche « une fois » n’est plus attendue', () => {
    expect(pendingSchedules([...cron('0 9 21 11 *', { id: 'aaaa1111', nextFireAt: NOW - 1000 }), fire('aaaa1111', NOW - 1000)], NOW)).toEqual([]);
  });
  test('heure passée depuis longtemps sans trace de déclenchement : perdue, plus montrée', () => {
    expect(pendingSchedules(cron('0 6 21 11 *', { id: 'aaaa1111', nextFireAt: NOW - 2 * H }), NOW)).toEqual([]);
  });
  test('programmée avant le démarrage du process (session fermée puis reprise) : morte avec l’ancien process', () => {
    expect(pendingSchedules(cron('13 2 22 11 *', { id: 'aaaa1111', nextFireAt: TONIGHT }), NOW, NOW - H / 2)).toEqual([]);
  });
  test('durable : survit à la reprise', () => {
    expect(pendingSchedules(cron('13 2 22 11 *', { id: 'aaaa1111', nextFireAt: TONIGHT, durable: true }), NOW, NOW - H / 2)).toHaveLength(1);
  });
  test('récurrente : la prochaine heure est recalculée après un déclenchement ; expire 7 jours après sa création', () => {
    const lines = [...cron('*/30 * * * *', { id: 'cccc3333', recurring: true, nextFireAt: NOW - 30 * 60000 }), fire('cccc3333', NOW - 30 * 60000)];
    const [j] = pendingSchedules(lines, NOW);
    expect(j!.recurring).toBe(true);
    expect(j!.at! > NOW && j!.at! <= NOW + 30 * 60000).toBe(true);
    expect(pendingSchedules(lines, NOW + 8 * 24 * H)).toEqual([]);
  });
  test('appel refusé (is_error), copie envoyée à l’API, sous-agent : ignorés', () => {
    const u = use('CronCreate', { cron: '13 2 22 11 *', prompt: 'x' });
    const err = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'refusé' }] }, toolUseResult: { id: 'dddd4444', nextFireAt: TONIGHT } });
    const blob = '{"type":"api-request-blob","message":' + JSON.stringify({ content: [{ type: 'tool_use', id: 'toolu_x', name: 'CronCreate', input: {} }] }) + '}';
    const side = cron('13 2 22 11 *', { id: 'eeee5555', nextFireAt: TONIGHT }).map((l) => l.replace('"isSidechain":false', '"isSidechain":true'));
    expect(pendingSchedules([u.line, err, blob, ...side], NOW)).toEqual([]);
  });
});

describe('pendingSchedules : ScheduleWakeup', () => {
  test('un réveil en attente, remplacé par le suivant, annulé par stop', () => {
    const a = use('ScheduleWakeup', { delaySeconds: 1800, prompt: 'vérifier le déploiement de test' });
    const b = use('ScheduleWakeup', { delaySeconds: 3600, prompt: 'revérifier', reason: 'filet' });
    const one = [a.line, res(a.id, { scheduledFor: NOW + 0.5 * H })];
    const two = [...one, b.line, res(b.id, { scheduledFor: NOW + H })];
    expect(pendingSchedules(one, NOW).map((j) => [j.kind, j.at, j.prompt])).toEqual([['wakeup', NOW + 0.5 * H, 'vérifier le déploiement de test']]);
    expect(pendingSchedules(two, NOW).map((j) => j.at)).toEqual([NOW + H]);
    const s = use('ScheduleWakeup', { stop: true });
    expect(pendingSchedules([...two, s.line, res(s.id, { scheduledFor: 0, stopped: true })], NOW)).toEqual([]);
    expect(pendingSchedules(two, NOW + 2 * H)).toEqual([]);   // passé : réveillée
  });
});

describe('nextCronFire', () => {
  test('heure locale, champs listes, plages et pas', () => {
    const from = new Date(2026, 10, 21, 10, 7).getTime();   // samedi 21 novembre 2026, 10 h 07
    expect(nextCronFire('13 2 22 11 *', from)).toBe(new Date(2026, 10, 22, 2, 13).getTime());
    expect(nextCronFire('*/10 7-20 * * 1-5', from)).toBe(new Date(2026, 10, 23, 7, 0).getTime());   // lundi
    expect(nextCronFire('0,30 * * * *', from)).toBe(new Date(2026, 10, 21, 10, 30).getTime());
    expect(nextCronFire('n’importe quoi', from)).toBeNull();
  });
});

describe('ScheduleScan : lecture incrémentale', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-sched-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  test('ne garde que les lignes utiles, et ne relit que ce qui a été ajouté', () => {
    const f = join(dir, 't.jsonl');
    writeFileSync(f, JSON.stringify({ type: 'user', message: { content: 'bonjour' } }) + '\n' + cron('13 2 22 11 *', { id: 'aaaa1111', nextFireAt: TONIGHT }).join('\n') + '\n');
    const sc = new ScheduleScan();
    expect(sc.lines(f)).toHaveLength(2);
    appendFileSync(f, del('aaaa1111').join('\n') + '\n' + '{"type":"user","message":{"content":"ligne en cours d');   // dernière ligne pas finie
    expect(sc.lines(f)).toHaveLength(4);
    expect(pendingSchedules(sc.lines(f), NOW)).toEqual([]);
  });
});
