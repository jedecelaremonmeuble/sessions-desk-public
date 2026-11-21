// ACTIONS — portage de Invoke-Send, Invoke-Keys, Invoke-Focus, Invoke-Close, Invoke-CloseMany, Invoke-Relaunch,
// Invoke-Reopen, Invoke-ReopenMany, Invoke-New, Invoke-SendMany, Test-Closable. Mêmes garde-fous, mêmes messages.
// Elles passent toutes par la FILE unique (voir http.ts) : une à la fois, comme la boucle PowerShell.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './gitpr.ts';
import { draftHolds, promptDraft } from './prompt.ts';
import { isRelance } from './quiet.ts';
import { checkTag, type Dashboard, type Session } from './state.ts';
import { addContent, GUID, ieq, isDir, netTrim, nowMs, psArray, psIntZero, psString, sleep } from './util.ts';
import { T } from './i18n.ts';
import { commandOf, Commands } from './commands.ts';
import { UNTRUSTED_REFUSED } from './trust.ts';

const KEY_NAMES = ['Enter', 'Esc', 'Up', 'Down', 'Left', 'Right', 'Tab', 'ShiftTab', 'Space', 'Backspace'];
const NOT_EMPTY = "l'invite de la session n'est pas vide (brouillon, menu ou dialogue ouvert)";
const NOT_GONE = "tapé dans l'invite de la session, mais pas parti : le texte y est resté — envoie-le ou vide l'invite depuis le panneau « Invite occupée »";
const notEmpty = (): string => T(NOT_EMPTY, 'the session prompt is not empty (draft, menu or dialog open)');
const notGone = (): string => T(NOT_GONE, 'typed into the session prompt, but not sent: the text is still there — send it or clear the prompt from the "Prompt busy" panel');
/** « ; » sépare les commandes de wt.exe, même entre guillemets : un dossier qui en contient couperait la ligne en deux
 *  commandes. Ouvrir, rouvrir ou relancer une session dans un tel dossier est refusé. */
export const SEMICOLON_REFUSED = 'dossier refusé : son chemin contient « ; », que Windows Terminal lirait comme une seconde commande';
const semicolonRefused = (): string => T(SEMICOLON_REFUSED, 'folder refused: its path contains ";", which Windows Terminal would read as a second command');

/** Shells à l'invite desquels une reprise peut être tapée (nom du process → ligne : se replacer dans le dossier de
 *  la conversation, puis reprendre). Tout autre parent : la session reprend dans un nouvel onglet. */
export const SHELL_RESUME: Record<string, (cwd: string, resume: string) => string> = {
  pwsh: (cwd, resume) => `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; ${resume}`,
  powershell: (cwd, resume) => `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; ${resume}`,
  cmd: (cwd, resume) => `cd /d "${cwd}" && ${resume}`,
};

/** Nettoyage d'une ligne envoyée : ni saut de ligne, ni tabulation, ni caractère de contrôle. */
export function cleanLine(text: string): string { return text.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, ''); }
/** Ligne prête à être tapée puis validée par Entrée. Une barre oblique inverse en fin de ligne est retirée : dans
 *  Claude Code, « \ » puis Entrée va à la ligne au lieu d'envoyer — le message resterait dans l'invite, qui refuserait
 *  ensuite tout envoi. */
export function submitLine(text: string): string { return netTrim(netTrim(cleanLine(text)).replace(/[\\\s]+$/, '')); }

function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } }
async function waitExit(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (!alive(pid)) return true; await sleep(100); }
  return !alive(pid);
}
function kill(pid: number): void { try { process.kill(pid, 'SIGKILL'); } catch { /* déjà mort */ } }

/** Menu « Select model » lu à l'écran : ses lignes numérotées, celle que le curseur « ❯ » désigne, et s'il offre
 *  « s to use this session only ». null : ce n'est pas ce menu. */
export interface ModelMenu { opts: { num: number; label: string }[]; cur: number; sessionOnly: boolean }
export function parseModelMenu(screen: string): ModelMenu | null {
  const L = screen.split('\n');
  let foot = -1;
  for (let i = L.length - 1; i >= Math.max(0, L.length - 12); i--) if (/enter to (save|select|confirm)/i.test(L[i]!) && /esc to cancel/i.test(L[i]!)) { foot = i; break; }
  if (foot < 0) return null;
  const opts: ModelMenu['opts'] = []; let cur = -1;
  for (let i = Math.max(0, foot - 30); i < foot; i++) {
    const m = /^\s*(❯\s*)?(\d{1,2})\.\s+(\S.*?)\s*$/.exec(L[i]!);
    if (!m) continue;
    const num = Number(m[2]);
    if (num === 1) { opts.length = 0; cur = -1; }
    if (num !== opts.length + 1) continue;
    if (m[1]) cur = opts.length;
    opts.push({ num, label: m[3]!.split(/\s{2,}/)[0]!.replace(/\s*✔\s*$/, '').trim() });
  }
  if (opts.length < 2 || cur < 0) return null;
  return { opts, cur, sessionOnly: /\bs to use this session only\b/i.test(L[foot]!) };
}
/** La ligne du menu qui correspond au modèle demandé (« opus », « haiku »…) : la première dont le libellé le contient,
 *  hors ligne « Default » (elle désigne le réglage par défaut, pas un modèle). -1 : absent. */
export function pickModel(menu: ModelMenu, want: string): number {
  const w = want.trim().toLowerCase();
  return menu.opts.findIndex((o) => !/^default\b/i.test(o.label) && o.label.toLowerCase().includes(w));
}

export class Actions {
  readonly d: Dashboard;
  readonly commands: Commands;
  constructor(d: Dashboard) { this.d = d; this.commands = new Commands(d.cfg?.claude ?? ''); }
  get sentLog(): string { return this.d.sf('sessions-dashboard-sent.jsonl'); }
  async session(pid: number): Promise<Session | undefined> { return (await this.d.openSessions()).find((s) => Number(s.pid) === pid); }

  /** Invoke-Focus */
  async focus(pid: number): Promise<number> {
    let code = 2;
    try { code = await this.d.driver.call('focus', { pid }); } catch { /* pilote injoignable */ }
    const s = await this.session(pid);
    this.d.setSeen(s ? [s.sessionId] : []);
    return code;
  }

  /** Invoke-Send : session inactive, invite vide, une ligne ≤ 4 000 caractères, journalisé.
   *  Proposition COUPÉE à l'écran (elle finit par « … », Claude Code la tronque à la largeur du terminal) : son texte
   *  complet n'est lisible nulle part, on ne peut donc pas le taper. Elle est acceptée dans le terminal — Tab, puis
   *  Entrée — après la même revérification : ce qui est à l'écran est encore exactement ce que la page a montré.
   *  allowBusy : MESSAGE EN FILE — une session au travail garde son invite vide et active ; Claude Code met en file
   *  ce qu'on y tape. Réponse à une session seulement (ni message groupé, ni proposition). */
  async send(pid: number, text: string, suggested = false, allowBusy = false): Promise<string | null> {
    const line = submitLine(text);
    if (!line) return T('message vide', 'empty message');
    if (line.length > 4000) return T('message trop long (4 000 caractères au plus)', 'message too long (4,000 characters max)');
    const sess = await this.session(pid);
    if (!sess) return T('session introuvable', 'session not found');
    const queued = allowBusy && !suggested && ieq(sess.status, 'busy');
    if (!ieq(sess.status, 'idle') && !ieq(sess.status, 'shell') && !queued) return T(`la session n'est pas inactive (statut ${psString(sess.status)})`, `the session is not idle (status ${psString(sess.status)})`);
    if (suggested) {
      let cur: string | null = null;
      try { cur = await this.d.driver.call('suggestion', { pid }); } catch { /* idem */ }
      if (!cur) return T("plus de proposition à l'écran", 'no suggestion on screen anymore');
      if (cur !== line) return T("la proposition a changé à l'écran", 'the suggestion changed on screen');
    }
    const cut = suggested && line.endsWith('…');
    let code = 2;
    try { code = cut ? await this.d.driver.call('sendKeys', { pid, items: ['\u0001Tab', '\u0001Enter'] }) : await this.d.driver.call('send', { pid, line }); } catch { /* inaccessible */ }
    addContent(this.sentLog, JSON.stringify({ at: nowMs(), pid, sessionId: sess.sessionId, title: sess.title, code, text: line, suggested, queued, ...(cut ? { cut: true } : {}), ...(commandOf(line) ? { command: commandOf(line) } : {}) }));
    // Une relance du veilleur n'est pas toi : elle ne marque pas « vue » une réponse que tu n'as pas encore lue.
    if (code === 0) {
      // « Envoyé » se vérifie : si le texte est encore dans l'invite, il n'est pas parti (Entrée lue comme un collage,
      // caractère qui change le sens d'Entrée…). Le dire tout de suite, plutôt qu'un refus incompris au message suivant.
      if (!cut && await this.stuck(pid, line)) {
        addContent(this.sentLog, JSON.stringify({ at: nowMs(), pid, sessionId: sess.sessionId, title: sess.title, code: 6, text: line, notGone: true }));
        return notGone();
      }
      if (!isRelance(line)) this.d.setSeen([sess.sessionId]);
      return null;
    }
    return code === 5 ? notEmpty() : T('console de la session inaccessible', 'session console unreachable');
  }

  /** Délai laissé à l'invite pour se vider après Entrée, avant de la relire. */
  settleMs = 400;
  /** Le texte tapé est-il resté dans l'invite ? Écran illisible ou invite absente : on ne conclut pas. */
  async stuck(pid: number, line: string): Promise<boolean> {
    await sleep(this.settleMs);
    let scr: unknown = null;
    try { scr = await this.d.driver.call('read', { pid }); } catch { /* idem */ }
    if (typeof scr !== 'string' || !draftHolds(promptDraft(scr, null), line)) return false;
    // Curseur resté juste après « ❯ » : rien n'est tapé dans l'invite, ce qu'on y lit est une proposition de prompt.
    let sg: unknown = null;
    try { sg = await this.d.driver.call('suggestion', { pid }); } catch { /* idem */ }
    return !(typeof sg === 'string' && sg);
  }

  /** Invoke-Keys : réponse à un dialogue d'une session qui ATTEND ; l'option visée est relue à l'écran juste avant.
   *  Session INACTIVE : accepté aussi, pour débloquer une invite occupée (texte resté, menu) ou un dialogue ouvert
   *  hors attente — mais seulement avec un texte à retrouver à l'écran (expect) : jamais de touche à l'aveugle. */
  async keys(pid: number, keys: unknown, expect: string): Promise<string | null> {
    const items: string[] = []; let len = 0;
    for (const raw of psArray(keys)) {
      const k = (raw && typeof raw === 'object' ? raw : {}) as { k?: unknown; t?: unknown };
      if (k.k) { const name = psString(k.k); if (!KEY_NAMES.includes(name)) return T('touche inconnue', 'unknown key'); items.push('\u0001' + name); }
      else if (k.t !== null && k.t !== undefined) { const t = cleanLine(psString(k.t)).replace(/\\+$/, ''); if (t) { items.push(t); len += t.length; } }
    }
    if (!items.length) return T('rien à envoyer', 'nothing to send');
    if (items.length > 20 || len > 4000) return T('trop de touches ou texte trop long', 'too many keys or text too long');
    const sess = await this.session(pid);
    if (!sess) return T('session introuvable', 'session not found');
    const unblock = !!expect && (ieq(sess.status, 'idle') || ieq(sess.status, 'shell'));
    if (!ieq(sess.status, 'waiting') && !unblock) return T(`la session n'attend plus de réponse (statut ${psString(sess.status)})`, `the session is no longer waiting for an answer (status ${psString(sess.status)})`);
    if (expect) {
      let scr: unknown = null;
      try { scr = await this.d.driver.call('read', { pid }); } catch { /* idem */ }
      if (typeof scr !== 'string' || !scr.includes(expect)) return T(`le dialogue a changé : « ${expect} » n'est plus à l'écran`, `the dialog changed: "${expect}" is no longer on screen`);
    }
    let code = 2;
    try { code = await this.d.driver.call('sendKeys', { pid, items }); } catch { /* idem */ }
    addContent(this.sentLog, JSON.stringify({ at: nowMs(), pid, sessionId: sess.sessionId, title: sess.title, code, keys: items.map((x) => x.replaceAll('\u0001', '#')), expect }));
    if (code === 0) { this.d.setSeen([sess.sessionId]); return null; }
    return code === 3 ? T('touche inconnue', 'unknown key') : T('console de la session inaccessible', 'session console unreachable');
  }

  /** Délais du changement de modèle : attente du menu, pause après une touche (tests : 0). */
  modelWaitMs = 4000; modelStepMs = 350;
  /** MODÈLE POUR CETTE SESSION SEULEMENT. « /model <nom> » écrit aussi le réglage par défaut des prochaines sessions ;
   *  le seul chemin qui s'arrête à la session est le menu : /model, curseur sur le modèle, touche « s ». On le rejoue,
   *  en relisant l'écran à chaque pas : menu ouvert et offrant bien « s » (sinon la version de Claude Code ne sait pas
   *  le faire : Échap, refus), modèle trouvé parmi les lignes numérotées, curseur arrivé dessus, puis la question
   *  « Switch model? » (posée quand une conversation est en cache) validée. Au moindre écart : Échap et refus —
   *  jamais Entrée dans ce menu, qui enregistrerait le choix comme réglage par défaut. */
  async sessionModel(pid: number, wantRaw: string): Promise<string | null> {
    const want = wantRaw.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9 .\-]{0,40}$/.test(want)) return T('modèle invalide', 'invalid model');
    const sess = await this.session(pid);
    if (!sess) return T('session introuvable', 'session not found');
    if (!ieq(sess.status, 'idle')) return T(`la session n'est pas inactive (statut ${psString(sess.status)})`, `the session is not idle (status ${psString(sess.status)})`);
    const call = async (op: string, args: Record<string, unknown>): Promise<unknown> => { try { return await this.d.driver.call(op, args); } catch { return null; } };
    const read = async (): Promise<string> => { const s = await call('read', { pid }); return typeof s === 'string' ? s : ''; };
    const keys = async (...items: string[]): Promise<boolean> => { const ok = (await call('sendKeys', { pid, items })) === 0; await sleep(this.modelStepMs); return ok; };
    const log = (extra: Record<string, unknown>): void => { addContent(this.sentLog, JSON.stringify({ at: nowMs(), pid, sessionId: sess.sessionId, title: sess.title, command: '/model', sessionOnly: true, want, ...extra })); };
    const giveUp = async (why: string): Promise<string> => { await keys('\u0001Esc'); log({ code: 7, error: why }); return why; };

    const code = await call('send', { pid, line: '/model' });
    if (code !== 0) return code === 5 ? notEmpty() : T('console de la session inaccessible', 'session console unreachable');
    let menu: ModelMenu | null = null;
    for (const until = Date.now() + this.modelWaitMs; ;) {
      menu = parseModelMenu(await read());
      if (menu || Date.now() >= until) break;
      await sleep(Math.min(300, this.modelStepMs || 1));
    }
    if (!menu) {
      // Rien de reconnu : si un dialogue tient l'écran (plus d'invite), on le referme ; sinon rien n'a été ouvert.
      if (promptDraft(await read(), null) === null) await keys('\u0001Esc');
      const why = T('menu /model non reconnu à l\'écran', '/model menu not recognised on screen'); log({ code: 7, error: why }); return why;
    }
    if (!menu.sessionOnly) return giveUp(T('ce menu /model ne propose pas « cette session seulement » (version de Claude Code ?)', 'this /model menu has no "this session only" choice (Claude Code version?)'));
    const target = pickModel(menu, want);
    if (target < 0) return giveUp(T(`modèle « ${want} » absent du menu (${menu.opts.map((o) => o.label).join(', ')})`, `model "${want}" not in the menu (${menu.opts.map((o) => o.label).join(', ')})`));
    const delta = target - menu.cur;
    if (delta && !(await keys(...Array.from({ length: Math.abs(delta) }, () => (delta > 0 ? '\u0001Down' : '\u0001Up'))))) return giveUp(T('console de la session inaccessible', 'session console unreachable'));
    const at = parseModelMenu(await read());
    if (!at || at.cur !== target || at.opts[target]?.label !== menu.opts[target]!.label) return giveUp(T('le curseur du menu n\'est pas arrivé sur le modèle demandé', 'the menu cursor did not reach the requested model'));
    await keys('s');
    let scr = await read();
    if (/Switch model\?/i.test(scr) && /❯\s*1\.\s+Yes/i.test(scr)) { await keys('\u0001Enter'); scr = await read(); }
    const label = menu.opts[target]!.label;
    if (promptDraft(scr, null) === null) { log({ code: 8, model: label }); return T(`« ${label} » choisi, mais un dialogue est encore ouvert : à finir dans le panneau « Dialogue » ou le terminal`, `"${label}" picked, but a dialog is still open: finish it in the "Dialog" panel or the terminal`); }
    log({ code: 0, model: label });
    this.d.setSeen([sess.sessionId]);
    return null;
  }

  /** Invoke-Close : /exit si inactive (arrêt du process s'il ne sort pas en 10 s) ; sinon needForce, puis arrêt sur force. */
  async close(pid: number, force: boolean): Promise<Record<string, unknown>> {
    const sess = await this.session(pid);
    if (!sess) return { error: T('session introuvable', 'session not found') };
    if (!alive(pid)) return { error: T('process introuvable', 'process not found') };
    if (!force) {
      if (!ieq(sess.status, 'idle')) return { error: T(`la session travaille (statut ${psString(sess.status)})`, `the session is working (status ${psString(sess.status)})`), needForce: true };
      let code = 2; try { code = await this.d.driver.call('send', { pid, line: '/exit' }); } catch { /* idem */ }
      if (code === 5) return { error: notEmpty(), needForce: true };
      force = !(code === 0 && await waitExit(pid, 10000));
    }
    if (force) { kill(pid); if (!await waitExit(pid, 5000)) return { error: T("le process n'a pas pu être arrêté", 'the process could not be stopped') }; }
    try { rmSync(join(this.d.sessionsDir, `${pid}.json`), { force: true }); } catch { /* idem */ }
    this.d.openSeen.delete(psString(sess.sessionId));
    addContent(this.sentLog, JSON.stringify({ at: nowMs(), pid, sessionId: sess.sessionId, title: sess.title, forced: force, text: '(fermeture)' }));
    return { error: null, forced: force };
  }

  /** Test-Closable : même règle que la page (closable dans app.js). */
  static closable(s: Session): boolean {
    const g = s.git; const merged = !!s.prInfo && ieq(psString(s.prInfo.state), 'MERGED');
    if (!ieq(s.status, 'idle') || !g) return false;
    if (!g.worktree) return merged;
    if ((Number(g.nFiles) || 0) > 0 || (g.upstream && (Number(g.ahead) || 0) > 0)) return false;
    return merged || !!(g.upstream && g.merged);
  }
  /** Invoke-CloseMany */
  /** Invoke-CloseMany — rule 'idle' : seul « inactive » est revérifié (ménage large) ; sinon Test-Closable. */
  async closeMany(pids: unknown, rule = 'closable'): Promise<Record<string, unknown>> {
    const all = await this.d.openSessions(); const closed: unknown[] = []; const skipped: unknown[] = [];
    for (const p of psArray(pids).slice(0, 60)) {
      const id = psIntZero(p);
      const s = all.find((x) => Number(x.pid) === id);
      if (!s) continue;
      if (rule === 'idle') { if (!ieq(s.status, 'idle')) { skipped.push({ title: s.title, why: T(`n'est plus inactive (statut ${psString(s.status)})`, `is no longer idle (status ${psString(s.status)})`) }); continue; } }
      else if (!Actions.closable(s)) { skipped.push({ title: s.title, why: T('ne peut plus se fermer (état changé)', 'can no longer be closed (state changed)') }); continue; }
      const r = await this.close(Number(s.pid), false);
      if (r.error) skipped.push({ title: s.title, why: r.error }); else closed.push({ title: s.title, forced: Boolean(r.forced) });
    }
    return { closed, skipped };
  }

  /** Invoke-Relaunch */
  async relaunch(pid: number): Promise<string | null> {
    const sess = await this.session(pid);
    if (!sess) return T('session introuvable', 'session not found');
    if (!ieq(sess.status, 'idle')) return T(`la session n'est pas inactive (statut ${psString(sess.status)})`, `the session is not idle (status ${psString(sess.status)})`);
    const m = this.d.meta(sess.sessionId);
    if (!m.path) return T('aucun transcript : la session ne pourrait pas être reprise', 'no transcript: the session could not be resumed');
    if (!m.cwd || !isDir(m.cwd)) return T('dossier de lancement introuvable', 'launch folder not found');
    if (m.cwd.includes(';')) return semicolonRefused();      // AVANT de fermer : la session ne pourrait pas être rouverte
    const was = alive(pid);
    let code = 2; try { code = await this.d.driver.call('send', { pid, line: '/exit' }); } catch { /* idem */ }
    if (code === 5) return notEmpty();
    if (was && (code !== 0 || !await waitExit(pid, 15000))) { kill(pid); if (!await waitExit(pid, 5000)) return T("le process n'a pas pu être arrêté", 'the process could not be stopped'); }
    try { rmSync(join(this.d.sessionsDir, `${pid}.json`), { force: true }); } catch { /* idem */ }
    return this.reopen(sess.sessionId);
  }

  /** Attente, après une relance groupée, que les sessions relancées soient de nouveau listées (0 : pas de contrôle). */
  backWaitMs = 45000;
  /** Délai laissé au shell pour reprendre la main après la sortie de la session, avant d'y taper la reprise. */
  promptWaitMs = 1500;

  /** Relance GROUPÉE : chaque session inactive reçoit /exit puis reprend sa conversation (`--resume`). Sert quand le
   *  process doit vraiment redémarrer : compte changé, serveurs MCP à réinitialiser.
   *  Reprise dans le MÊME onglet quand la session a été lancée d'un shell connu : la ligne est tapée à son invite une
   *  fois la session sortie. Sinon dans un nouvel onglet, comme la relance d'une seule session.
   *  Trois temps, pour ne pas attendre chaque sortie l'une après l'autre : /exit à toutes, attente commune, reprises.
   *  Une session au travail, bloquée sur un dialogue ou dont l'invite porte un brouillon est sautée, jamais arrêtée. */
  async relaunchMany(pids: unknown): Promise<Record<string, unknown>> {
    const all = await this.d.openSessions();
    const relaunched: { title: string | null; sameTab: boolean }[] = []; const skipped: { title: string | null; why: string }[] = [];
    const parents = new Map<number, number>(); const shells = new Map<number, string>();
    try { for (const p of await this.d.driver.call('procs', { name: 'claude', commandLine: true }) as { pid: number; parent?: number }[]) if (p.parent) parents.set(p.pid, p.parent); } catch { /* sans parent connu : nouvel onglet */ }
    for (const name of Object.keys(SHELL_RESUME)) {
      try { for (const p of await this.d.driver.call('procs', { name }) as { pid: number }[]) shells.set(p.pid, name); } catch { /* idem */ }
    }
    const log = (s: Session, pid: number, code: number, result: string): void => {
      addContent(this.d.sf('restart-idle-sessions.jsonl'), JSON.stringify({ at: nowMs(), pid, name: psString(s.title ?? s.name), sessionId: s.sessionId, code, result }));
    };

    // 1. /exit à chaque session qui peut la recevoir. Tout ce qui empêcherait la reprise est vérifié AVANT.
    const out: { s: Session; pid: number; cwd: string; shell: number | null; line: string; sameTab: boolean }[] = [];
    const seen = new Set<number>();
    for (const p of psArray(pids).slice(0, 60)) {
      const pid = psIntZero(p);
      const s = all.find((x) => Number(x.pid) === pid);
      if (!s || seen.has(pid)) continue;
      seen.add(pid);
      const skip = (why: string): void => { skipped.push({ title: s.title, why }); };
      if (s.headless) { skip(T('automate sans terminal', 'automation without a terminal')); continue; }
      if (!ieq(s.status, 'idle')) { skip(T(`n'est pas inactive (statut ${psString(s.status)})`, `is not idle (status ${psString(s.status)})`)); continue; }
      const m = this.d.meta(s.sessionId);
      if (!m.path) { skip(T('aucun transcript : elle ne pourrait pas être reprise', 'no transcript: it could not be resumed')); continue; }
      if (!m.cwd || !isDir(m.cwd)) { skip(T('dossier de lancement introuvable', 'launch folder not found')); continue; }
      const par = parents.get(pid); const kind = par === undefined ? undefined : shells.get(par);
      if (!kind && m.cwd.includes(';')) { skip(semicolonRefused()); continue; }
      if (!alive(pid)) { skip(T('process introuvable', 'process not found')); continue; }
      let code = 2; try { code = await this.d.driver.call('send', { pid, line: '/exit' }); } catch { /* idem */ }
      if (code !== 0) { skip(code === 5 ? notEmpty() : T('console de la session inaccessible', 'session console unreachable')); continue; }
      const resume = `claude ${this.d.cfg.claudeArgs} --resume ${s.sessionId}`;
      out.push({ s, pid, cwd: m.cwd, shell: kind ? par! : null, line: kind ? SHELL_RESUME[kind]!(m.cwd, resume) : '', sameTab: false });
    }

    // 2. Sorties attendues ensemble ; une session qui ne sort pas est arrêtée (sa conversation est sur disque).
    const gone = await Promise.all(out.map((o) => waitExit(o.pid, 15000)));
    const ready: typeof out = [];
    for (const [i, o] of out.entries()) {
      if (!gone[i]) { kill(o.pid); if (!await waitExit(o.pid, 5000)) { skipped.push({ title: o.s.title, why: T("le process n'a pas pu être arrêté", 'the process could not be stopped') }); log(o.s, o.pid, 3, 'pas sortie : relance non tapée'); continue; } }
      try { rmSync(join(this.d.sessionsDir, `${o.pid}.json`), { force: true }); } catch { /* idem */ }
      ready.push(o);
    }

    // 3. Reprises : à l'invite du shell d'origine, sinon dans un nouvel onglet (un seul appel à Windows Terminal).
    if (ready.some((o) => o.shell)) await sleep(this.promptWaitMs);
    const tabs: typeof out = []; const typed: typeof out = [];
    for (const o of ready) {
      if (o.shell && alive(o.shell)) {
        let code = 2; try { code = await this.d.driver.call('sendKeys', { pid: o.shell, items: [o.line, '\u0001Enter'] }); } catch { /* idem */ }
        if (code === 0) { o.sameTab = true; typed.push(o); continue; }
      }
      if (o.cwd.includes(';')) { skipped.push({ title: o.s.title, why: T('fermée, non reprise : ' + SEMICOLON_REFUSED, 'closed, not resumed: ' + semicolonRefused()) }); log(o.s, o.pid, 2, 'fermée, non reprise'); continue; }
      tabs.push(o);
    }
    if (tabs.length) {
      try { await this.wt('-w 0 ' + tabs.map((o) => this.resumeTab(o.s.sessionId, o.cwd)).join(' ; ')); typed.push(...tabs); }
      catch { for (const o of tabs) { skipped.push({ title: o.s.title, why: T('fermée, non reprise : nouvel onglet impossible (elle est dans « Fermées »)', 'closed, not resumed: could not open a new tab (it is in "Closed")') }); log(o.s, o.pid, 2, 'fermée, non reprise'); } }
    }

    // 4. Contrôle : une session relancée redevient listée. Celle qui ne revient pas est dite, pas comptée.
    let back: Set<string> | null = null;
    const until = Date.now() + this.backWaitMs;
    while (typed.length && Date.now() < until) {
      await sleep(Math.min(2000, this.backWaitMs));
      back = new Set((await this.d.openSessions()).map((x) => x.sessionId));
      if (typed.every((o) => back!.has(o.s.sessionId))) break;
    }
    for (const o of typed) {
      const where = o.sameTab ? 'dans son onglet' : 'dans un nouvel onglet';
      if (back && !back.has(o.s.sessionId)) {
        skipped.push({ title: o.s.title, why: T(`reprise demandée ${where}, mais pas réapparue : voir son onglet (sinon elle est dans « Fermées »)`, `resume requested ${o.sameTab ? 'in its tab' : 'in a new tab'}, but it did not come back: check its tab (otherwise it is in "Closed")`) });
        log(o.s, o.pid, 6, `reprise demandée ${where}, pas réapparue`);
      } else { relaunched.push({ title: o.s.title, sameTab: o.sameTab }); log(o.s, o.pid, 0, `relancée ${where}`); }
      addContent(this.sentLog, JSON.stringify({ at: nowMs(), pid: o.pid, sessionId: o.s.sessionId, title: o.s.title, text: '(relance groupée)' }));
    }
    return { relaunched, skipped };
  }

  resumeTab(id: string, cwd: string): string { return `nt -d "${cwd}" pwsh -NoExit -Command "claude ${this.d.cfg.claudeArgs} --resume ${id}"`; }
  async wt(args: string): Promise<void> { await this.d.driver.call('wt', { args }); }

  /** Invoke-Reopen : nouvel onglet de la fenêtre Windows Terminal la plus récente. */
  async reopen(id: string): Promise<string | null> {
    if (!GUID.test(id)) return T('identifiant invalide', 'invalid id');
    if ((await this.d.openSessions()).some((s) => s.sessionId === id)) return T('session déjà ouverte', 'session already open');
    const m = this.d.meta(id);
    if (!m.path) return T('transcript introuvable', 'transcript not found');
    if (!m.cwd || !isDir(m.cwd)) return T('dossier de lancement introuvable', 'launch folder not found');
    if (m.cwd.includes(';')) return semicolonRefused();
    await this.wt(`-w 0 ${this.resumeTab(id, m.cwd)}`);
    return null;
  }
  /** Invoke-ReopenMany : UN seul appel à Windows Terminal, un onglet par session. */
  async reopenMany(ids: unknown): Promise<Record<string, unknown>> {
    const open = new Set((await this.d.openSessions()).map((s) => s.sessionId));
    const tabs: string[] = []; let skipped = 0;
    for (const raw of psArray(ids).slice(0, 40)) {
      const id = psString(raw);
      if (!GUID.test(id) || open.has(id)) { skipped++; continue; }
      const m = this.d.meta(id);
      if (!m.path || !m.cwd || !isDir(m.cwd) || m.cwd.includes(';')) { skipped++; continue; }
      tabs.push(this.resumeTab(id, m.cwd));
    }
    if (!tabs.length) return { error: T('aucune session à rouvrir', 'no session to reopen'), opened: 0, skipped };
    await this.wt('-w 0 ' + tabs.join(' ; '));
    return { error: null, opened: tabs.length, skipped };
  }

  /** Invoke-SendMany */
  async sendMany(pids: unknown, text: string, force = false): Promise<Record<string, unknown>> {
    const results: unknown[] = [];
    for (const p of psArray(pids).slice(0, 40)) {
      const id = psIntZero(p); if (!id) continue;
      const s = await this.session(id);
      const bad = this.commands.check(submitLine(text), psString(s?.cwd), force, true);
      results.push({ pid: id, title: s?.title ?? null, error: bad ? bad.error : await this.send(id, text), ...(bad?.unknownCommand ? { unknownCommand: bad.unknownCommand } : {}) });
    }
    return { results };
  }

  /** Envoi tapé dans la page : la garde des commandes « / » d'abord (commands.ts), puis l'envoi ordinaire.
   *  Les envois internes (relances, fermeture) passent par `send` sans garde. */
  async sendFromPage(pid: number, text: string, suggested: boolean, force: boolean): Promise<{ error: string | null; unknownCommand?: string }> {
    if (!suggested) {
      const s = await this.session(pid);
      const bad = s ? this.commands.check(submitLine(text), psString(s.cwd), force, false) : null;
      if (bad) return bad;
    }
    return { error: await this.send(pid, text, suggested, true) };
  }

  /** Invoke-New : nouvelle session (dossier proposé, premier message, modèle, worktree neuf facultatif,
   *  session source facultative : `--resume <id> --fork-session`, nouvel identifiant, source intacte). */
  async newSession(cwd: string, prompt: string, model: string, branchRaw: string, forkRaw = '', tagsRaw: unknown = undefined, sidRaw = ''): Promise<string | null> {
    const want = cwd.replace(/\\+$/, '');
    const dir = (await this.d.newFolders()).find((f) => ieq(f.path, want));
    if (!dir) return T('dossier non proposé', 'folder not offered');
    if (model && !/^[A-Za-z0-9][A-Za-z0-9.\-\[\]]{0,60}$/.test(model)) return T('modèle invalide', 'invalid model');
    if (prompt.length > 20000) return T('premier message trop long', 'first message too long');
    const forkFrom = forkRaw.trim();
    if (forkFrom) {
      if (!GUID.test(forkFrom)) return T('session source : identifiant invalide', 'source session: invalid id');
      if (!this.d.meta(forkFrom).path) return T('session source : transcript introuvable', 'source session: transcript not found');
    }
    // Tags choisis à la création : mêmes contrôles que la correction à la main, TOUS vérifiés avant d'ouvrir l'onglet.
    // Identifiant choisi par l'appelant (veilleur Teams : il doit retrouver la session qu'il ouvre) : jamais un identifiant déjà pris.
    const wantSid = sidRaw.trim();
    if (wantSid) {
      if (!GUID.test(wantSid)) return T('identifiant de session invalide', 'invalid session id');
      if (this.d.meta(wantSid).path) return T('identifiant de session déjà pris', 'session id already taken');
    }
    const sid = wantSid || randomUUID(); const newTags: [string, string][] = [];
    if (tagsRaw !== undefined && tagsRaw !== null) {
      if (!Array.isArray(tagsRaw)) return T('tags : liste attendue', 'tags: a list is expected');
      if (tagsRaw.length > 8) return T('tags : 8 au plus', 'tags: 8 at most');
      const vocab = this.d.tagVocab();
      for (const t of tagsRaw) {
        const o = (t !== null && typeof t === 'object' ? t : {}) as Record<string, unknown>;
        const a = psString(o.axis), v = psString(o.v).trim();
        const e = checkTag(sid, a, v, vocab); if (e) return T(`tag ${a}:${v} : ${e}`, `tag ${a}:${v}: ${e}`);
        newTags.push([a, v]);
      }
    }
    const branch = branchRaw.trim(); let prelude = ''; let startDir = dir.path;
    if (branch) {
      if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){0,2}$/i.test(branch) || branch.length > 80 || /\.\.|\.lock$|\/$/i.test(branch))
        return T('nom de branche invalide (minuscules, chiffres, . _ - et /, ex. feat/hd-123456-x)', 'invalid branch name (lowercase, digits, . _ - and /, e.g. feat/hd-123456-x)');
      const r = await run('git', ['-C', dir.path, 'rev-parse', '--show-toplevel']);
      const top = r.out.trim().replace(/\//g, '\\');
      if (r.code !== 0 || !top) return T("ce dossier n'est pas dans un dépôt git", 'this folder is not in a git repository');
      if ((await run('git', ['-C', top, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`])).code === 0) return T(`la branche ${branch} existe déjà`, `branch ${branch} already exists`);
      const wt = join(top, '.claude', 'worktrees', branch.split('/').at(-1)!);
      if (existsSync(wt)) return T(`le dossier ${wt} existe déjà`, `folder ${wt} already exists`);
      let rel = dir.path.slice(Math.min(top.length, dir.path.length)).replace(/^\\+/, '');
      if (!dir.path.toLowerCase().startsWith(top.toLowerCase())) rel = '';
      const q = (s: string): string => "'" + s.replace(/'/g, "''") + "'";
      prelude = `Write-Host 'Worktree neuf : ${branch.replace(/'/g, "''")} sur origin/master…' -ForegroundColor Cyan; `
        + `git -C ${q(top)} fetch origin master; `
        + `git -C ${q(top)} worktree add -b ${q(branch)} ${q(wt)} origin/master; `
        + "if ($LASTEXITCODE) { Write-Host 'Échec de la création du worktree : session non lancée.' -ForegroundColor Red; return }; "
        + `Set-Location -LiteralPath ${q(join(wt, rel))}; `;
      startDir = top;
    }
    // Dossier non approuvé par Claude Code : la session resterait bloquée en silence sur la question d'approbation
    // (trust.ts). Seul « non approuvé » refuse ; un statut inconnu (configuration illisible) laisse lancer. Un worktree
    // neuf (branche demandée) n'est jamais approuvé d'avance : l'onglet posera la question et la page le dit (app.js,
    // trustHint) — refuser rendrait les branches neuves inutilisables.
    if (!branch && this.d.trusted?.(dir.path) === false) { const [fr, en] = UNTRUSTED_REFUSED(dir.path); return T(fr, en); }
    if (startDir.includes(';')) return semicolonRefused();
    let cmd =`claude ${this.d.cfg.claudeArgs}`;
    if (model) cmd += ` --model ${model}`;
    if (forkFrom) cmd += ` --resume ${forkFrom} --fork-session`;
    // Identifiant fixé d'avance (--session-id, admis avec --fork-session) : tags posés AVANT le démarrage.
    if (newTags.length || wantSid) cmd += ` --session-id ${sid}`;
    let p = prompt.trim();
    if (p) {
      // « -x » serait lu comme une option, un mot seul (« update ») comme une sous-commande : une espace devant suffit.
      if (/^-/.test(p) || /^[\p{L}\p{Mn}\p{Nd}\p{Pc}]+$/u.test(p)) p = ' ' + p;
      const pd = this.d.sf('new-session-prompts'); mkdirSync(pd, { recursive: true });
      const file = join(pd, `${randomUUID()}.txt`);
      writeFileSync(file, p, 'utf8');
      const lit = file.replace(/'/g, "''");
      cmd = `$p = [IO.File]::ReadAllText('${lit}'); Remove-Item -LiteralPath '${lit}'; ${cmd} $p`;
    }
    for (const [a, v] of newTags) this.d.setTag(sid, a, v, true);
    const b64 = Buffer.from(prelude + cmd, 'utf16le').toString('base64');
    await this.wt(`-w 0 nt -d "${startDir}" pwsh -NoExit -EncodedCommand ${b64}`);
    return null;
  }
}

