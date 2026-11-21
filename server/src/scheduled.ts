// TÂCHES PROGRAMMÉES D'UNE SESSION — une session peut se programmer elle-même du travail pour plus tard :
//   · CronCreate (une fois ou récurrent) : son tool_result porte `toolUseResult` { id, recurring, durable, nextFireAt } ;
//     CronDelete { id } l'annule ; une ligne « system » `scheduled_task_fire` (taskId) marque chaque déclenchement,
//     après quoi une tâche « une fois » disparaît. Un récurrent expire de lui-même 7 jours après sa création.
//   · ScheduleWakeup (boucle /loop) : un seul réveil en attente à la fois (`scheduledFor`), `stopped` l'annule.
// Sauf `durable`, ces tâches vivent dans le PROCESS de la session : la fermer ou la relancer les annule. On rejoue
// donc tout le transcript (pas seulement sa fin : l'opération est souvent programmée des heures avant) pour savoir ce
// qui est encore attendu, et la page le montre en clair. Lecture incrémentale : seules les lignes utiles sont gardées.
import { readRange } from './util.ts';

export interface Scheduled {
  id: string;
  kind: 'cron' | 'wakeup';
  /** Prochain déclenchement (ms) ; null si on ne sait pas le calculer (expression cron inattendue). */
  at: number | null;
  cron: string | null;
  recurring: boolean;
  /** Écrite sur disque par Claude Code : survit à la fermeture de la session. */
  durable: boolean;
  /** Consigne qui sera envoyée à la session (tronquée). */
  prompt: string;
  /** Programmée le (ms). */
  since: number;
}

const TOOLS = new Set(['CronCreate', 'CronDelete', 'ScheduleWakeup']);
// Filtre grossier avant JSON.parse : appel d'un des trois outils, son résultat, ou un déclenchement.
const USEFUL = /"name":"(?:CronCreate|CronDelete|ScheduleWakeup)"|"nextFireAt"|"scheduledFor"|"Cancelled job|"scheduled_task_fire"/;
const RECURRING_TTL = 7 * 24 * 3600 * 1000;
/** Une tâche « une fois » dont l'heure est passée depuis plus longtemps que ça sans trace de déclenchement : perdue. */
const ONE_SHOT_GRACE = 15 * 60 * 1000;
const WAKEUP_GRACE = 2 * 60 * 1000;
const PROMPT_MAX = 600;

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const ms = (v: unknown): number => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? t : 0; };

/**
 * Tâches encore attendues, d'après les lignes utiles du transcript (dans l'ordre du fichier).
 * `startedAt` : démarrage du process de la session (ms) — une tâche non durable programmée avant est morte avec
 * le process précédent (session fermée puis reprise).
 */
export function pendingSchedules(lines: readonly string[], now: number, startedAt = 0): Scheduled[] {
  const calls = new Map<string, { name: string; input: J; at: number }>();
  const jobs = new Map<string, Scheduled & { last: number }>();
  let wakeup: Scheduled | null = null;
  for (const l of lines) {
    if (l.startsWith('{"type":"api-request')) continue;          // copies des messages envoyés à l'API : pas des faits
    let j: J;
    try { j = JSON.parse(l) as J; } catch { continue; }
    if (j.isSidechain === true) continue;
    const at = ms(j.timestamp);
    if (j.type === 'system') {
      if (j.subtype !== 'scheduled_task_fire') continue;
      const id = str(j.taskId); const job = id ? jobs.get(id) : undefined;
      if (job) { if (job.recurring) job.last = at; else jobs.delete(id!); }
      continue;
    }
    if (j.type !== 'user' && j.type !== 'assistant') continue;
    const content = isObj(j.message) ? j.message.content : null;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!isObj(b)) continue;
      if (j.type === 'assistant' && b.type === 'tool_use' && TOOLS.has(String(b.name))) {
        calls.set(String(b.id), { name: String(b.name), input: isObj(b.input) ? b.input : {}, at });
        continue;
      }
      if (j.type !== 'user' || b.type !== 'tool_result') continue;
      const call = calls.get(String(b.tool_use_id));
      if (!call) continue;
      calls.delete(String(b.tool_use_id));
      if (b.is_error === true) continue;
      const r = isObj(j.toolUseResult) ? j.toolUseResult : {};
      const prompt = (str(call.input.prompt) ?? '').slice(0, PROMPT_MAX);
      if (call.name === 'CronCreate') {
        const id = str(r.id); if (!id) continue;
        const next = Number(r.nextFireAt);
        jobs.set(id, {
          id, kind: 'cron', at: Number.isFinite(next) && next > 0 ? next : null, cron: str(call.input.cron) ?? str(r.humanSchedule),
          recurring: r.recurring === true, durable: r.durable === true, prompt, since: call.at || at, last: 0,
        });
      } else if (call.name === 'CronDelete') {
        const id = str(r.id) ?? str(call.input.id); if (id) jobs.delete(id);
      } else if (r.stopped === true || call.input.stop === true) wakeup = null;
      else {
        const next = Number(r.scheduledFor);
        if (Number.isFinite(next) && next > 0) {
          wakeup = { id: 'wakeup', kind: 'wakeup', at: next, cron: null, recurring: false, durable: false,
            prompt: prompt || (str(call.input.reason) ?? '').slice(0, PROMPT_MAX), since: call.at || at };
        }
      }
    }
  }
  const out: Scheduled[] = [];
  for (const { last, ...job } of jobs.values()) {
    if (!job.durable && startedAt > 0 && job.since > 0 && job.since < startedAt) continue;
    if (job.recurring) {
      if (job.since > 0 && now - job.since > RECURRING_TTL) continue;
      if (job.at === null || job.at <= Math.max(now, last)) job.at = job.cron ? nextCronFire(job.cron, Math.max(now, last)) : null;
    } else if (job.at !== null && job.at < now - ONE_SHOT_GRACE) continue;
    out.push(job);
  }
  if (wakeup && wakeup.at! > now - WAKEUP_GRACE && !(startedAt > 0 && wakeup.since < startedAt)) out.push(wakeup);
  return out.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
}

/** Un champ cron (« * », « 5 », « 1-5 », « *\/10 », « 0,30 ») → valeurs admises entre lo et hi ; null si illisible. */
function field(s: string, lo: number, hi: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of s.split(',')) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const a = m[1] === '*' ? lo : Number(m[1]); const b = m[2] !== undefined ? Number(m[2]) : m[1] === '*' || m[3] ? hi : a;
    const step = m[3] ? Number(m[3]) : 1;
    if (a < lo || b > hi || a > b || step < 1) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/** Prochaine minute (heure locale) qui satisfait l'expression cron à 5 champs, strictement après `from` ; null si illisible. */
export function nextCronFire(expr: string, from: number): number | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [mi, h, dom, mo, dowRaw] = [field(f[0]!, 0, 59), field(f[1]!, 0, 23), field(f[2]!, 1, 31), field(f[3]!, 1, 12), field(f[4]!, 0, 7)];
  if (!mi || !h || !dom || !mo || !dowRaw) return null;
  const dow = new Set([...dowRaw].map((d) => d % 7));
  const domAny = f[2] === '*', dowAny = f[4] === '*';
  const d = new Date(from); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (!mo.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    // Règle cron : jour du mois OU jour de la semaine quand les deux sont restreints.
    const dayOk = domAny && dowAny ? true : domAny ? dow.has(d.getDay()) : dowAny ? dom.has(d.getDate()) : dom.has(d.getDate()) || dow.has(d.getDay());
    if (!dayOk) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!h.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!mi.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d.getTime();
  }
  return null;
}

/** Lecture incrémentale des transcripts : garde, par fichier, les seules lignes utiles et la position lue. */
export class ScheduleScan {
  readonly #c = new Map<string, { off: number; size: number; lines: string[] }>();

  /** `size` : taille du fichier si l'appelant la connaît déjà — inchangée depuis la dernière lecture complète, le
   *  fichier n'est pas rouvert. Disque muet (slowfs.ts) : les lignes déjà connues, la suite au tour suivant. */
  lines(path: string, size?: number): string[] {
    let c = this.#c.get(path);
    if (!c) { c = { off: 0, size: -1, lines: [] }; this.#c.set(path, c); }
    if (size !== undefined && size >= 0 && size === c.size) return c.lines;
    const r = readRange(path, c.off);
    if (!r) return c.lines;
    if (r.from !== c.off) { c.off = 0; c.lines = []; }                   // fichier réécrit : on reprend du début
    const all = Buffer.from(r.buf.buffer, r.buf.byteOffset, r.buf.byteLength);
    const last = all.lastIndexOf(10);
    let i = 0;
    while (i <= last) {
      const e = all.indexOf(10, i);
      if (e - i > 20) { const l = all.toString('utf8', i, e); if (USEFUL.test(l)) c.lines.push(l); }
      i = e + 1;
    }
    c.off += last + 1;
    // Lu jusqu'au bout (une lecture est plafonnée) : cette taille n'a plus rien à apprendre.
    c.size = r.from + all.length === r.size ? r.size : -1;
    return c.lines;
  }
}
