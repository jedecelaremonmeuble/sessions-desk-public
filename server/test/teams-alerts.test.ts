// Send-TeamsAlerts porté dans Node (serveur principal) : une alerte par message, jamais deux, et
// rien pour une alerte déjà ancienne au démarrage.
import { describe, expect, it } from 'vitest';
import type { Session } from '../src/state.ts';
import { teamsAlertsDue } from '../src/watch.ts';

const now = 1_800_000_000_000;
const sess = [{ sessionId: 'aaaaaaaa-1111', pid: 42, title: 'Fil Camille', name: 'nom' } as unknown as Session];
const wait = (o: Record<string, unknown>) => ({ messageId: 'm1', chatLabel: 'Camille', reminders: 2, excerpt: 'tu as vu ?', ...o });

describe('teamsAlertsDue', () => {
  it('notifie une attente alertée, une seule fois', () => {
    const seen = new Set<string>();
    const summary = { sessions: { 'aaaaaaaa-1111': [wait({ alertedAt: now - 1000 })] } };
    const a = teamsAlertsDue(summary, seen, { now, sessions: sess });
    expect(a).toEqual([{ session: { sessionId: 'aaaaaaaa-1111', pid: 42 }, title: "🔔 Camille n'a pas répondu (2 relances)", text: 'Fil Camille — « tu as vu ? »' }]);
    expect(teamsAlertsDue(summary, seen, { now, sessions: sess })).toEqual([]);
  });
  it('ignore les attentes non alertées et les alertes de plus de 10 min (sans les renotifier ensuite)', () => {
    const seen = new Set<string>();
    const summary = { sessions: { 'aaaaaaaa-1111': [wait({}), wait({ messageId: 'm2', alertedAt: now - 700000 })] } };
    expect(teamsAlertsDue(summary, seen, { now, sessions: sess })).toEqual([]);
    expect(seen.has('m2')).toBe(true);
    expect(seen.has('m1')).toBe(false);
  });
  it('session fermée : libellé = début de l’id, pid 0 ; chat sans nom', () => {
    const a = teamsAlertsDue({ sessions: { 'bbbbbbbb-2222': wait({ chatLabel: '', alertedAt: now }) } }, new Set(), { now, sessions: [] });
    expect(a[0]).toMatchObject({ session: { sessionId: 'bbbbbbbb-2222', pid: 0 }, title: "🔔 le chat Teams n'a pas répondu (2 relances)", text: 'bbbbbbbb — « tu as vu ? »' });
  });
  it('résumé absent ou mal formé : rien', () => {
    expect(teamsAlertsDue(null, new Set(), { now, sessions: [] })).toEqual([]);
    expect(teamsAlertsDue({ sessions: [] }, new Set(), { now, sessions: [] })).toEqual([]);
  });
});
