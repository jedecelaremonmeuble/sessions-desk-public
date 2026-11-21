// SURVEILLANCE (toutes les 2 s, page ouverte ou non) — Watch-Waiting, Send-Notif, Update-SeenFromForeground,
// Register-FocusProtocol, Send-TeamsAlerts du serveur PowerShell historique. Rôle « side » (instance à côté du
// principal) : seules les lectures (état git, qui va dans un fichier suffixé) tournent ; notifications, « vu », alertes
// du lanceur et Teams, état des PR restent au serveur principal.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { refreshPrs, startGitRefresh } from './gitpr.ts';
import type { Automations } from './automations.ts';
import type { Launcher } from './launcher.ts';
import type { Dashboard, Session } from './state.ts';
import { addContent, ieq, leaf, netTrim, nowMs, psString } from './util.ts';
import { roundHalfEven } from './usage.ts';
import { probableCause } from './launch-watch.ts';
import { T } from './i18n.ts';

export class Watch {
  readonly d: Dashboard;
  readonly launcher: Launcher;
  readonly automations: Automations | null;
  #workStart = new Map<string, number>();
  #notified = new Map<string, number>();
  #seeded = false;
  #fgCandidate: string | null = null;
  #prAsked = 0;
  #prRunning = false;
  #gitAsked = 0;
  #teamsAlerted = new Set<string>();

  constructor(d: Dashboard, launcher: Launcher, automations: Automations | null = null) { this.d = d; this.launcher = launcher; this.automations = automations; }

  /** Send-Notif : gardée (mémoire + fichier) pour la page, puis toast par le pilote. */
  notify(kind: string, session: { sessionId: string | null; pid: number }, title: string, text: string, hd?: string, pass?: string): void {
    // hd : le clic ouvre le dernier run ; pass (« automate:passe ») : le clic ouvre la passe d'un automate
    const e = { at: nowMs(), kind, sessionId: session.sessionId, title, text, ...(hd ? { hd } : {}), ...(pass ? { pass } : {}) };
    this.d.notifs.push(e); while (this.d.notifs.length > 200) this.d.notifs.shift();
    try { addContent(this.d.sf('sessions-dashboard-notifs.jsonl'), JSON.stringify(e)); } catch { /* idem */ }
    const launch = pass ? `${this.d.cfg.url}?pass=${encodeURIComponent(pass)}` : hd ? `${this.d.cfg.url}?run=${hd}` : kind === 'launcher' ? `${this.d.cfg.url}?view=launcher` : kind === 'launch' ? this.d.cfg.url : `cc-focus://${session.pid}`;
    this.d.driver.call('toast', { title, text, launch }).catch(() => undefined);
  }

  /** Update-PrState : relance gh toutes les 5 min sur les PR connues. */
  #updatePrState(): void {
    if (this.#prRunning || nowMs() - this.#prAsked < 5 * 60000) return;
    const urls = [...new Set([...this.d.metaCache.values()].map((m) => m.prUrl).filter((u): u is string => !!u))].sort();
    if (!urls.length) return;
    this.#prAsked = nowMs(); this.#prRunning = true;
    refreshPrs(this.d, urls).catch(() => undefined).finally(() => { this.#prRunning = false; });
  }
  /** Update-GitState : toutes les 3 min. */
  #updateGitState(sessions: Session[]): void {
    if (nowMs() - this.#gitAsked < 3 * 60000) return;
    this.#gitAsked = nowMs();
    startGitRefresh(this.d, sessions.map((s) => s.gitDir)).catch(() => undefined);
  }

  /** Update-SeenFromForeground : onglet « à relire » au premier plan, toi au clavier, deux passes de suite. */
  async #seenFromForeground(sessions: Session[]): Promise<void> {
    const unseen = sessions.filter((s) => s.done);
    let fg: string | null = null;
    if (unseen.length && (await this.d.driver.call('idleSeconds', {})) < 60) fg = await this.d.driver.call('foregroundTitle', {});
    if (!fg) { this.#fgCandidate = null; return; }
    const same: Session[] = [];
    for (const s of sessions) { let t: string | null = null; try { t = await this.d.driver.call('title', { pid: Number(s.pid) }); } catch { /* idem */ } if (ieq(t, fg)) same.push(s); }
    const hit = same.length === 1 && same[0]!.done ? same[0]!.sessionId : null;
    if (hit && hit === this.#fgCandidate) { this.d.setSeen([hit]); this.#fgCandidate = null; } else this.#fgCandidate = hit;
  }

  /** Watch-Waiting */
  async tick(st: { now: number; sessions: Session[] }): Promise<void> {
    const cfg = this.d.cfg;
    // Update-PrState : relu ici, pas au calcul de l'état — sans surveillance (-NoBackground), le .ps1 n'a pas d'état des PR.
    this.d.readPrState();
    if (cfg.primary) { try { this.#updatePrState(); } catch { /* idem */ } }
    try { this.#updateGitState(st.sessions); } catch { /* idem */ }
    if (!cfg.primary) return;
    // « Lancée mais rien ne tourne » (launch-watch.ts) : une notification par lancement, la page garde le bandeau.
    try {
      for (const l of this.d.launches.takeAlerts()) {
        const c = probableCause(l, l.worktree ? false : this.d.trusted(l.cwd));
        this.notify('launch', { sessionId: null, pid: 0 }, T('Nouvelle session : rien ne tourne', 'New session: nothing is running'), `${leaf(l.cwd) || l.cwd} — ${c.text}`);
      }
    } catch { /* idem */ }
    if (this.launcher.enabled) try { await this.launcher.runAlerts((t, x, hd) => this.notify('launcher', { sessionId: null, pid: 0 }, t, x, hd)); } catch { /* idem */ }
    if (this.automations?.enabled) try {          // échecs des automates du poste seulement (passAlerts)
      for (const { def, pass } of this.automations.alerts()) {
        const what = pass.level === 'error' ? 'échec' : 'alerte répétée';
        this.notify('automation', { sessionId: pass.sessionId, pid: 0 }, `${def.icon ? def.icon + ' ' : ''}${def.label} : ${what}`, pass.summary, undefined, `${def.id}:${pass.run}`);
      }
    } catch { /* idem */ }
    if (cfg.modules.teams) try { for (const a of teamsAlertsDue(this.d.teamsWaits(), this.#teamsAlerted, st)) this.notify('waiting', a.session, a.title, a.text); } catch { /* idem */ }
    try { await this.#seenFromForeground(st.sessions); } catch { /* idem */ }
    for (const s of st.sessions) {
      if (s.headless) continue;
      const label = psString(s.title ?? s.name);
      const said = psString(s.reply).split('\n').map(netTrim).filter(Boolean).slice(-2);
      let detail = said.length ? said.join(' ') : `${psString(s.name)} — ${psString(s.lastPrompt)}`;
      if (detail.length > 200) detail = '…' + detail.slice(detail.length - 200);
      if (ieq(s.status, 'idle')) {
        const start = this.#workStart.get(s.sessionId); this.#workStart.delete(s.sessionId);
        if (start && cfg.notifyDoneAfterMinutes > 0 && s.statusSince - start >= cfg.notifyDoneAfterMinutes * 60000) {
          const min = roundHalfEven((s.statusSince - start) / 60000);
          this.notify('done', s, `${label} a terminé (${min} min)`, detail);
        }
      } else if (!this.#workStart.get(s.sessionId)) {
        this.#workStart.set(s.sessionId, this.#seeded ? s.statusSince : st.now);
      }
      if (!ieq(s.status, 'waiting')) { this.#notified.delete(s.sessionId); continue; }
      if (this.#notified.get(s.sessionId) === s.statusSince) continue;
      if (!this.#seeded) { this.#notified.set(s.sessionId, s.statusSince); continue; }
      if (cfg.notifyAfterSeconds <= 0 || st.now - s.statusSince < cfg.notifyAfterSeconds * 1000) continue;
      this.#notified.set(s.sessionId, s.statusSince);
      this.notify('waiting', s, `${label} attend une réponse`, detail);
    }
    this.#seeded = true;
  }
}

/** Send-TeamsAlerts : une attente Teams restée sans réponse après les relances (alertedAt posé par teams-watcher.ts)
 * ⇒ une notification Windows, une seule fois par message ; au démarrage, une alerte de plus de 10 min n'est pas
 * renotifiée. `alerted` est tenu par l'appelant (mémoire du process, comme $teamsAlerted du .ps1). Pure. */
export function teamsAlertsDue(summary: unknown, alerted: Set<string>, st: { now: number; sessions: Session[] }):
    { session: { sessionId: string; pid: number }; title: string; text: string }[] {
  const out: { session: { sessionId: string; pid: number }; title: string; text: string }[] = [];
  const sessions = (summary as { sessions?: Record<string, unknown> } | null)?.sessions;
  if (!sessions || typeof sessions !== 'object') return out;
  for (const [sid, list] of Object.entries(sessions)) {
    for (const w of (Array.isArray(list) ? list : [list]) as Record<string, unknown>[]) {
      if (!w || !w.alertedAt || alerted.has(String(w.messageId))) continue;
      alerted.add(String(w.messageId));
      if (st.now - Number(w.alertedAt) > 600000) continue;
      const s = st.sessions.find((x) => x.sessionId === sid);
      const who = w.chatLabel ? psString(w.chatLabel) : 'le chat Teams';
      const label = s ? psString(s.title ?? s.name) : sid.slice(0, 8);
      out.push({ session: { sessionId: sid, pid: s ? Number(s.pid) : 0 }, title: `🔔 ${who} n'a pas répondu (${psString(w.reminders)} relances)`, text: `${label} — « ${psString(w.excerpt)} »` });
    }
  }
  return out;
}

/** Register-FocusProtocol : le clic sur un toast ouvre cc-focus://<pid>, branché sur focus-session.ps1. */
export function registerFocusProtocol(legacyDir: string): Promise<void> {
  const reg = (args: string[]): Promise<void> => new Promise((ok) => { execFile('reg.exe', args, { windowsHide: true }, () => ok()); });
  return new Promise<string>((ok) => execFile('where.exe', ['pwsh'], { windowsHide: true }, (_e, out) => ok(String(out ?? '').split(/\r?\n/)[0]!.trim() || 'pwsh')))
    .then(async (pwsh) => {
      const key = 'HKCU\\Software\\Classes\\cc-focus';
      const cmd = `"${pwsh}" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${join(legacyDir, 'focus-session.ps1')}" -Uri "%1"`;
      await reg(['add', key, '/ve', '/d', 'URL:Session Claude Code', '/f']);
      await reg(['add', key, '/v', 'URL Protocol', '/d', '', '/f']);
      await reg(['add', `${key}\\shell\\open\\command`, '/ve', '/d', cmd, '/f']);
    });
}
