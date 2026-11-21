// SERVEUR HTTP — portage de la façade C# (Front) et de la boucle PowerShell de legacy/sessions-dashboard.ps1.
//
// Comme le .ps1 : la FAÇADE répond tout de suite à la page, au ping, à l'état et aux fermées (instantanés recalculés
// chaque seconde / toutes les 15 s), à l'écran d'une session, à la conversation, aux pièces jointes et au hook ; tout
// le reste passe par une FILE traitée une requête à la fois (la « boucle » : actions, recherche, dossiers, lanceur),
// entre deux calculs d'état — jamais en même temps qu'eux. Mêmes en-têtes, mêmes codes, mêmes refus d'accès.
// En plus du .ps1 : --allow-write absent ⇒ toute action est refusée (serveur À CÔTÉ en lecture seule).
import { langOf, T, withLang } from './i18n.ts';
import { UsageProbe } from './usage-probe.ts';
import { PEER_GET, PEER_HEADER, PEER_POST, Peers, peerRoute } from './peers.ts';
import { relayHealth, tailscaleIdentity, tailscaleServePort, type RelayHealth } from './relay.ts';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, connect, type Server as TcpServer, type Socket } from 'node:net';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Actions } from './actions.ts';
import { defaultShortcuts } from './commands.ts';
import { Automations } from './automations.ts';
import type { Config } from './config.ts';
import { startGitRefresh } from './gitpr.ts';
import { answerCard, lookupCards } from './cards.ts';
import { Launcher, lookupDeliveryDiff, lookupHd, runLauncherOrder } from './launcher.ts';
import { parkedQuestions, type Parked } from './parked.ts';
import { promptDraft } from './prompt.ts';
import { Search } from './search.ts';
import type { Dashboard } from './state.ts';
import { readTranscript } from './transcript.ts';
import { upload } from './upload.ts';
import { readImage } from './image.ts';
import { addContent, exists, GUID, ieq, nowMs, psArray, psIntZero, psString, psTruthy, sleep, tryParseInt, tryParseUInt } from './util.ts';
import { Watch } from './watch.ts';
import { setPhase } from './stall.ts';
import { DeliveryKick, linkedPending, type KickSession, type KickSummary } from './teams-kick.ts';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applyAction, conversationThread, conversationsView, linkConversation, markConversationSeen, unlinkConversation } from './teams-watcher.ts';

/** Identifiant de CE démarrage du serveur : la page sait ainsi qu'il a redémarré, même entre deux lectures. */
const BOOT = `${Date.now().toString(36)}-${process.pid}`;
const PAGE: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};
const JSON_TYPE = 'application/json; charset=utf-8';
const REMOTE_OK = new Set(['/', '/app.js', '/app.css', '/api/ping', '/api/state', '/api/teams-conversations', '/api/teams-thread', '/api/closed', '/api/screen', '/api/transcript', '/api/find', '/api/folders', '/api/commands', '/api/launcher', '/api/launcher/file', '/api/launcher/hd', '/api/launcher/delivery-diff', '/api/tag-vocab', '/api/automations', '/api/automations/file', '/api/launcher/cards', '/api/image']);
const REMOTE_NEVER = new Set(['/api/stop', '/api/hook', '/api/test-busy', '/api/relay/restart']);
const ACTIONS = new Set(['/api/focus', '/api/reopen', '/api/ack', '/api/send', '/api/keys', '/api/model', '/api/relaunch', '/api/fav', '/api/new', '/api/close', '/api/hide', '/api/reopen-many', '/api/reboot-dismiss', '/api/git-refresh', '/api/close-many', '/api/relaunch-many', '/api/send-many', '/api/draft-save', '/api/draft-delete', '/api/tags', '/api/teams-wait', '/api/teams-seen', '/api/teams-reply', '/api/teams-link', '/api/launcher/order', '/api/automations/order', '/api/launcher/answer', '/api/relay/restart']);
const HEADLESS_REFUSED = new Set(['/api/focus', '/api/send', '/api/keys', '/api/model', '/api/close', '/api/relaunch']);
/** Routes d'un module optionnel : sans lui, elles n'existent pas (404, comme une route inconnue). */
const LAUNCHER_ROUTES = new Set(['/api/launcher', '/api/launcher/file', '/api/launcher/hd', '/api/launcher/order', '/api/launcher/cards', '/api/launcher/answer', '/api/test-launcher-alerts']);
const TEAMS_ROUTES = new Set(['/api/teams-wait', '/api/teams-conversations', '/api/teams-seen', '/api/teams-thread', '/api/teams-reply', '/api/teams-link']);
const AUTOMATION_ROUTES = new Set(['/api/automations', '/api/automations/file', '/api/automations/order']);
export const STALE_AFTER_SECONDS = 90;
const FORBIDDEN_URL = ['<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN""http://www.w3.org/TR/html4/strict.dtd">',
  '<HTML><HEAD><TITLE>Forbidden</TITLE>', '<META HTTP-EQUIV="Content-Type" Content="text/html; charset=us-ascii"></HEAD>',
  '<BODY><h2>Forbidden URL</h2>', '<hr><p>HTTP Error 403. The request URL is forbidden.</p>', '</BODY></HTML>', ''].join(String.fromCharCode(13, 10));
/** Le chemin brut remonte-t-il au-dessus de la racine ? */
function aboveRoot(raw: string): boolean {
  let depth = 0;
  const segs = raw.split('?')[0]!.split('/').slice(1);
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!.replace(/%2e/gi, '.');
    if (seg === '..') { if (--depth < 0) return true; } else if (seg !== '.' && !(seg === '' && i === segs.length - 1)) depth++;
  }
  return false;
}

interface Queued { req: IncomingMessage; res: ServerResponse; path: string; query: URLSearchParams }

/** Propriété d'un objet issu de ConvertFrom-Json : PowerShell la trouve sans tenir compte de la casse. */
export function pget(o: unknown, name: string): unknown {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const r = o as Record<string, unknown>;
  if (name in r) return r[name];
  const k = Object.keys(r).find((x) => x.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : r[k];
}
const header = (req: IncomingMessage, name: string): string | undefined => { const v = req.headers[name]; return Array.isArray(v) ? v.join(',') : v; };
function isLoopback(a: string | undefined): boolean { return !!a && (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a.startsWith('127.')); }

function reply(res: ServerResponse, code: number, type: string | null, body: Buffer | string): void {
  try {
    res.statusCode = code;
    if (type) res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  } catch { try { res.end(); } catch { /* fermé */ } }
}
const json = (res: ServerResponse, code: number, o: unknown): void => reply(res, code, JSON_TYPE, typeof o === 'string' ? o : JSON.stringify(o));
/** Corps JSON d'une action, corps du hook : 1 Mo au plus (une pièce jointe a sa propre limite, upload.ts). */
export const MAX_BODY = 1024 * 1024;
const TOO_BIG = { error: 'corps de requête trop gros (1 Mo au plus)' };
/** Corps lu en flux et plafonné : au-delà de MAX_BODY, null tout de suite — rien de plus n'est gardé en mémoire. */
export function readBody(req: IncomingMessage, maxChars = Infinity, maxBytes = MAX_BODY): Promise<string | null> {
  return new Promise((ok) => {
    let parts: Buffer[] = []; let size = 0; let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > maxBytes) { over = true; parts = []; ok(null); return; }
      parts.push(c);
    });
    req.on('end', () => { if (over) return; const s = Buffer.concat(parts).toString('utf8'); ok(s.length > maxChars ? s.slice(0, maxChars) : s); });
    req.on('error', () => { if (!over) ok(''); });
  });
}
/** 413, puis la connexion est coupée : le reste du corps n'est ni gardé ni attendu plus de 2 s. */
function tooBig(req: IncomingMessage, res: ServerResponse): void {
  req.resume();
  try { res.setHeader('Connection', 'close'); } catch { /* en-têtes déjà partis */ }
  json(res, 413, { error: T(TOO_BIG.error, 'request body too large (1 MB max)') });
  setTimeout(() => { try { req.socket.destroy(); } catch { /* fermé */ } }, 2000).unref();
}
/** Réponse du relais à un Host qui n'est pas le nom du poste sur le tailnet : rien n'est transmis au serveur. */
const RELAY_REFUSED = ((): Buffer => {
  const body = Buffer.from('{"error":"hôte refusé par le relais"}', 'utf8');
  return Buffer.concat([Buffer.from(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`, 'latin1'), body]);
})();
/** Le Host d'origine est-il le nom du poste sur le tailnet (celui de l'origine distante), sans la casse ni le port ?
 *  Identité Tailscale inconnue, Host absent ou répété ⇒ non. */
export function relayHostOk(host: string | null, hosts: number, remoteOrigin: string | null): boolean {
  if (remoteOrigin === null || hosts !== 1 || host === null) return false;
  return host.replace(/:[0-9]+$/, '').toLowerCase() === remoteOrigin.replace(/^https?:\/\//i, '').toLowerCase();
}
/** ConvertFrom-Json d'un corps : null s'il est vide ou illisible. */
function parseBody(s: string): unknown { try { return s.trim() ? JSON.parse(s) : null; } catch { return null; } }

export class Server {
  readonly cfg: Config;
  readonly d: Dashboard;
  readonly launcher: Launcher;
  readonly automations: Automations;
  readonly search: Search;
  readonly actions: Actions;
  readonly watch: Watch;
  /** Sonde d'usage (module quota, source usage-probe) : serveur principal, tâches de fond permises. */
  readonly usageProbe: UsageProbe | null;
  /** Autres postes du propriétaire (peers.ts) : serveur principal seulement. */
  readonly peers: Peers;
  remoteOwner: string | null = null;
  remoteOrigin: string | null = null;
  /** Santé du relais d'accès distant (relay.ts) : faits relevés ici, verdict dans l'état (`server.relay`). */
  #relaySrv: TcpServer | null = null;
  #relayError: string | null = null;
  #identityError: string | null = null;
  #servePort: number | null | undefined = undefined;
  #serveError: string | null = null;
  #relayCheckedAt = 0;
  #relayChecking: Promise<void> | null = null;
  uploadDir: string | null;
  #state: Buffer | null = null;
  #closed: Buffer | null = null;
  #beat = nowMs();
  #queue: Queued[] = [];
  #wake: (() => void) | null = null;
  #dirty = false;
  readonly #kick = new DeliveryKick();
  #firstState!: () => void;
  /** Résolue au premier état calculé par la boucle (trace de démarrage). */
  readonly firstState = new Promise<void>((ok) => { this.#firstState = ok; });
  #stopping = false;
  #draining = false;
  #inflight = 0;
  #servers: (HttpServer | TcpServer)[] = [];
  onStop: (() => void) | null = null;

  constructor(d: Dashboard) {
    this.d = d; this.cfg = d.cfg;
    this.launcher = new Launcher(d); this.automations = new Automations(d); this.search = new Search(d); this.actions = new Actions(d); this.watch = new Watch(d, this.launcher, this.automations);
    this.usageProbe = this.cfg.modules.quota?.probe && this.cfg.primary && !this.cfg.noBackground ? new UsageProbe(this.cfg) : null;
    this.uploadDir = join(this.cfg.claude, `uploads${this.cfg.suffix}`);
    this.peers = new Peers(this.cfg.primary ? this.cfg.peers : [], () => this.remoteOrigin);
  }

  beat(): void { this.#beat = nowMs(); }
  get errorsLog(): string { return this.d.sf(`sessions-dashboard-errors${this.cfg.suffix}.log`); }
  logError(msg: string): void { try { addContent(this.errorsLog, `${new Date().toISOString().slice(0, 19)} ${msg}`); } catch { /* idem */ } }

  // ───────────── démarrage, arrêt ─────────────
  async listen(): Promise<void> {
    if (!exists(join(this.cfg.pageDir, 'index.html'))) throw new Error(`Page introuvable : ${this.cfg.pageDir}`);
    // http.sys écoute « localhost » en IPv4 et IPv6 : deux sockets.
    for (const host of ['127.0.0.1', '::1']) {
      const s = createServer((req, res) => {
        // Arrêt en cours : refus net, que la page sait lire (bandeau de reconnexion) — jamais une requête acceptée puis coupée.
        if (this.#draining) { req.resume(); res.setHeader('Connection', 'close'); json(res, 503, { error: withLang(langOf(req.headers['x-sd-lang']), () => T("serveur en cours d'arrêt", 'server is shutting down')) }); return; }
        this.#inflight++; res.once('close', () => { this.#inflight--; });
        setPhase('requête');
        withLang(langOf(req.headers['x-sd-lang']), () => this.#handle(req, res)).catch((e) => { this.logError(`${req.url} : ${(e as Error).message}`); reply(res, 500, null, ''); });
      });
      s.keepAliveTimeout = 5000;
      await new Promise<void>((ok, ko) => { s.once('error', ko); s.listen(this.cfg.port, host, () => { s.off('error', ko); ok(); }); })
        .catch((e: NodeJS.ErrnoException) => { if (host === '::1' && e.code === 'EADDRNOTAVAIL') return; throw new Error(`Port ${this.cfg.port} déjà pris (serveur déjà lancé ?) : ${e.message}`); });
      this.#servers.push(s);
    }
    await this.#ensureRelay();
    try { writeFileSync(join(this.cfg.temp, `sessions-dashboard-${this.cfg.port}.pid`), String(process.pid)); } catch { /* idem */ }
  }
  /** ARRÊT PROPRE : plus aucune requête acceptée (503), celles déjà reçues — en file ou en cours — vont au bout, puis
   *  le serveur s'arrête. Plafonné à maxMs : un envoi bloqué ne retient pas un déploiement. C'est ce que demandent
   *  /api/stop et Ctrl+C ; Stop-Process -Force (impossible à intercepter sous Windows) ne reste qu'en dernier recours. */
  async shutdown(maxMs = 8000): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    const until = nowMs() + maxMs;
    while ((this.#inflight > 0 || this.#queue.length > 0) && nowMs() < until) await sleep(50);
    if (this.#inflight > 0 || this.#queue.length > 0) this.logError(`arrêt : ${this.#inflight} requête(s) en cours et ${this.#queue.length} en file abandonnées après ${maxMs} ms`);
    this.close(); this.onStop?.();
  }
  close(): void {
    this.#stopping = true; this.#wake?.();
    for (const s of this.#servers) { try { s.close(); } catch { /* idem */ } }
    try { rmSync(join(this.cfg.temp, `sessions-dashboard-${this.cfg.port}.pid`), { force: true }); } catch { /* idem */ }
  }

  // RELAIS pour l'accès distant (tailscale serve → 127.0.0.1:<port+1>) : réécrit Host, force Connection: close et
  // AJOUTE TOUJOURS X-Forwarded-For : tout ce qui passe par lui est traité comme DISTANT.
  // Il ne transmet que si le Host d'ORIGINE est le nom du poste sur le tailnet (relayHostOk) : une page d'un autre
  // site qui ferait pointer son nom sur 127.0.0.1 (DNS rebinding) arrive avec SON nom dans Host et reçoit 403, sans
  // que rien ne soit transmis. Identité Tailscale inconnue ⇒ tout est refusé.
  #startRelay(port: number, target: number): Promise<void> {
    const srv = createTcpServer((cl) => this.#relay(cl, target));
    return new Promise<void>((ok, ko) => { srv.once('error', ko); srv.listen(port, '127.0.0.1', () => { srv.off('error', ko); ok(); }); })
      .then(() => { this.#relaySrv = srv; this.#servers.push(srv); srv.on('close', () => { if (this.#relaySrv === srv) this.#relaySrv = null; }); });
  }
  /** Relais démarré s'il ne l'est pas ; l'échec est retenu pour l'affichage (port pris, par exemple). */
  async #ensureRelay(): Promise<void> {
    if (this.#relaySrv || this.#stopping) return;
    try { await this.#startRelay(this.cfg.port + 1, this.cfg.port); this.#relayError = null; }
    catch (e) { this.#relayError = (e as Error).message; process.stderr.write(`Relais d'accès distant (port ${this.cfg.port + 1}) non démarré : ${this.#relayError}\n`); }
  }
  /** Relit l'identité Tailscale (si elle manque, ou si `force`) et où `tailscale serve` renvoie. Une lecture à la fois. */
  checkRelay(force = false): Promise<void> {
    this.#relayChecking ??= (async () => {
      await Promise.resolve();   // jamais de fin synchrone : le finally remettrait null AVANT l'affectation
      try {
        if (!this.cfg.tailscaleExe) { this.#identityError = T('accès distant désactivé (--tailscale "")', 'remote access disabled (--tailscale "")'); return; }
        if (force || this.remoteOrigin === null) {
          try { const id = await tailscaleIdentity(this.cfg.tailscaleExe); this.remoteOwner = id.owner; this.remoteOrigin = id.origin; this.#identityError = null; }
          catch (e) { if (this.#identityError === null) this.logError(`écriture à distance désactivée : ${(e as Error).message}`); this.#identityError = (e as Error).message; }
        }
        if (this.remoteOrigin !== null) {
          try { this.#servePort = await tailscaleServePort(this.cfg.tailscaleExe, this.remoteOrigin); this.#serveError = null; }
          catch (e) { this.#servePort = undefined; this.#serveError = (e as Error).message; }
        }
      } finally { this.#relayCheckedAt = nowMs(); this.#relayChecking = null; }
    })();
    return this.#relayChecking;
  }
  /** Bouton « Relancer » de la page : relais redémarré s'il est arrêté, identité et `tailscale serve` relus. */
  async restartRelay(): Promise<RelayHealth> {
    await this.#ensureRelay();
    await this.checkRelay(true);
    return this.relayHealth();
  }
  relayHealth(): RelayHealth {
    return relayHealth({ port: this.cfg.port + 1, listening: this.#relaySrv !== null, listenError: this.#relayError,
      identity: this.remoteOrigin !== null && this.remoteOwner !== null ? { owner: this.remoteOwner, origin: this.remoteOrigin } : null,
      identityError: this.#identityError, servePort: this.#servePort, serveError: this.#serveError });
  }
  #relay(cl: Socket, target: number): void {
    cl.setTimeout(30000, () => cl.destroy());
    cl.on('error', () => undefined);
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) { if (head.length >= 65536) cl.destroy(); return; }
      cl.off('data', onData); cl.pause();
      const rest = head.subarray(end + 4);
      const lines = head.subarray(0, end).toString('latin1').split('\r\n');
      let out = lines[0] + '\r\n'; let len = 0; let xff = false; let host: string | null = null; let hosts = 0;
      for (const l of lines.slice(1)) {
        if (!l.length) continue;
        const k = l.indexOf(':'); const name = k > 0 ? l.slice(0, k).trim().toLowerCase() : '';
        if (name === 'host') { hosts++; host = l.slice(k + 1).trim(); continue; }
        if (['connection', 'keep-alive', 'proxy-connection'].includes(name)) continue;
        if (name === 'content-length') len = Number(l.slice(k + 1).trim()) || 0;
        if (name === 'x-forwarded-for') xff = true;
        out += l + '\r\n';
      }
      // Refus : fin d'envoi, puis le reste du corps est lu et jeté (fermer avec un corps non lu ferait perdre le 403).
      if (!relayHostOk(host, hosts, this.remoteOrigin)) { cl.resume(); cl.end(RELAY_REFUSED); return; }
      if (!xff) out += 'X-Forwarded-For: relais\r\n';
      out += `Host: localhost:${target}\r\nConnection: close\r\n\r\n`;
      const up = connect(target, '127.0.0.1', () => {
        up.write(Buffer.from(out, 'latin1'));
        let left = len;
        const body = rest.subarray(0, Math.min(rest.length, left)); if (body.length) { up.write(body); left -= body.length; }
        if (left > 0) {
          const onBody = (c: Buffer): void => { const part = c.subarray(0, Math.min(c.length, left)); up.write(part); left -= part.length; if (left <= 0) cl.off('data', onBody); };
          cl.on('data', onBody); cl.resume();
        }
        up.pipe(cl);
      });
      up.on('error', () => cl.destroy());
      up.on('close', () => cl.end());
    };
    cl.on('data', onData);
  }

  // ───────────── façade ─────────────
  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // http.sys n'accepte que le nom sous lequel il écoute (« Invalid Hostname ») : d'où le relais.
    if (!ieq(header(req, 'host'), `localhost:${this.cfg.port}`)) { reply(res, 400, 'text/html; charset=us-ascii', '<h2>Bad Request - Invalid Hostname</h2>'); req.resume(); return; }
    // http.sys refuse lui-même un chemin qui remonte au-dessus de la racine (« .. », « %2e%2e ») : 403 « Forbidden URL ».
    if (aboveRoot(req.url ?? '/')) { req.resume(); reply(res, 403, 'text/html; charset=us-ascii', FORBIDDEN_URL); return; }
    let url: URL;
    try { url = new URL(req.url ?? '/', this.cfg.url); } catch { reply(res, 400, null, ''); return; }
    const path = url.pathname; const method = req.method ?? 'GET'; const origin = header(req, 'origin');
    // REQUÊTE VENUE D'UN AUTRE SITE (le navigateur le dit : Sec-Fetch-Site) : jamais l'API. Ferme entre autres un
    // GET /api/stop déclenché par une image posée sur une page tierce. La page elle-même reste ouvrable par un lien.
    const site = header(req, 'sec-fetch-site')?.trim().toLowerCase();
    if (path.startsWith('/api/') && (site === 'cross-site' || site === 'same-site')) { req.resume(); json(res, 403, { error: T("requête venue d'un autre site", 'request from another site') }); return; }
    const login = header(req, 'tailscale-user-login');
    const remote = login !== undefined || header(req, 'x-forwarded-for') !== undefined || !isLoopback(req.socket.remoteAddress);
    const owner = remote && this.remoteOwner !== null && ieq(login, this.remoteOwner);
    if (path === '/api/whoami') {
      req.resume();
      json(res, 200, { remote, write: (!remote || owner) && this.cfg.allowWrite, login: login ?? '' });
      return;
    }
    // À DISTANCE : le propriétaire du poste seulement, en lecture comme en écriture — un autre membre du tailnet ne lit rien.
    if (remote) {
      if (!owner) { req.resume(); json(res, 403, { error: T('accès distant réservé au propriétaire du poste', 'remote access is reserved for the owner of this machine') }); return; }
      const readOk = method === 'GET' && (REMOTE_OK.has(path) || PEER_GET.has(peerRoute(path)?.op ?? ''));
      const writeOk = method === 'POST' && path.startsWith('/api/') && !REMOTE_NEVER.has(path) && this.remoteOrigin !== null && origin === this.remoteOrigin;
      if (!readOk && !writeOk) { req.resume(); json(res, 403, { error: T('action refusée à distance', 'action refused remotely') }); return; }
    }
    // Corps plafonné (hors pièce jointe, qui a sa propre limite) : longueur annoncée au-delà de 1 Mo ⇒ refus sans lire.
    if (method === 'POST' && path !== '/api/upload' && Number(header(req, 'content-length') ?? 0) > MAX_BODY) { tooBig(req, res); return; }
    const peer = peerRoute(path);
    if (peer) { await this.#peer(req, res, peer, method, origin, remote, url); return; }
    if (path === '/api/hook') {
      if (method === 'POST' && origin === undefined) { await this.#hook(req, res); } else { req.resume(); json(res, 403, '{}'); }
      return;
    }
    if (path === '/api/upload') {
      const fromPage = origin !== undefined && (origin === this.cfg.origin || (remote && this.remoteOrigin !== null && origin === this.remoteOrigin));
      if (method === 'POST' && fromPage) {
        if (!this.cfg.allowWrite) { req.resume(); json(res, 403, { error: T('serveur à côté en lecture seule (--allow-write pour écrire)', 'read-only side server (--allow-write to write)') }); return; }
        const r = await upload(req, this.uploadDir); json(res, r.status, r.body);
      } else { req.resume(); json(res, 403, '{}'); }
      return;
    }
    if (method === 'GET' && (origin === undefined || origin === this.cfg.origin)) {
      switch (path) {
        case '/': case '/app.js': case '/app.css': {
          const f = PAGE[path]!;
          let b: Buffer;
          try { b = readFileSync(join(this.cfg.pageDir, f[0])); } catch (e) { reply(res, 500, 'text/plain; charset=utf-8', `${f[0]} illisible : ${(e as Error).message}`); return; }
          reply(res, 200, f[1], b); return;
        }
        // Schéma du fichier de configuration, pour l'éditeur du poste (`"$schema": "http://localhost:8765/config.schema.json"`).
        case '/config.schema.json': {
          let b: Buffer;
          try { b = readFileSync(new URL('./config.schema.json', import.meta.url)); } catch (e) { reply(res, 500, 'text/plain; charset=utf-8', `config.schema.json illisible : ${(e as Error).message}`); return; }
          reply(res, 200, 'application/schema+json; charset=utf-8', b); return;
        }
        case '/api/ping': {
          const age = Math.floor((nowMs() - this.#beat) / 1000);
          if (age > STALE_AFTER_SECONDS) json(res, 503, { ok: false, stale: age }); else json(res, 200, { ok: true });
          return;
        }
        case '/api/state': { if (header(req, PEER_HEADER) === undefined) this.peers.touch(nowMs()); const b = await this.#wait(() => this.#state, 20); if (b) { reply(res, 200, JSON_TYPE, b); return; } break; }
        case '/api/closed': { const b = await this.#wait(() => this.#closed, 30); if (b) { reply(res, 200, JSON_TYPE, b); return; } break; }
        case '/api/transcript': this.#transcript(url, res); return;
        case '/api/image': {
          // Aperçu d'une image citée par chemin dans la conversation (voir image.ts). Cache court : la conversation
          // est redessinée à chaque lecture, la vignette ne doit pas être relue sur le disque à chaque fois.
          const r = readImage(url.searchParams.get('path'));
          try {
            res.statusCode = r.status; res.setHeader('Content-Type', r.type); res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Cache-Control', r.status === 200 ? 'private, max-age=300' : 'no-store');
            res.end(r.body);
          } catch { try { res.end(); } catch { /* fermé */ } }
          return;
        }
        case '/api/screen': {
          const pid = tryParseUInt(url.searchParams.get('pid'));
          if (pid === null || !exists(join(this.d.sessionsDir, `${pid}.json`))) { json(res, 400, '{}'); return; }
          let t: string | null = null; let sg: string | null = null;
          try { t = await this.d.driver.call('read', { pid }); } catch { /* illisible */ }
          if (t !== null) { try { sg = await this.d.driver.call('suggestion', { pid }); } catch { /* idem */ } }
          json(res, 200, { text: t, suggestion: sg, draft: promptDraft(t, sg), parked: this.#parked(pid) });
          return;
        }
      }
    }
    this.#queue.push({ req, res, path, query: url.searchParams });
    this.#wake?.();
  }

  /** `/api/peer/<poste>/<route>` : relais vers un autre poste du propriétaire (peers.ts). Liste fermée de routes ;
   *  jamais pour une demande venue elle-même d'un serveur ; écriture aux mêmes conditions qu'une action d'ici. Traité
   *  hors de la boucle : un poste lent ne retarde ni l'état ni les actions locales. */
  async #peer(req: IncomingMessage, res: ServerResponse, peer: { name: string; op: string }, method: string, origin: string | undefined, remote: boolean, url: URL): Promise<void> {
    const get = method === 'GET' && PEER_GET.has(peer.op), post = method === 'POST' && PEER_POST.has(peer.op);
    if (header(req, PEER_HEADER) !== undefined) { req.resume(); json(res, 403, { error: T('un relais ne se relaie pas', 'a relayed request is not relayed again') }); return; }
    if (!this.peers.has(peer.name) || (!get && !post)) { req.resume(); json(res, 404, '{}'); return; }
    const fromPage = get ? origin === undefined || origin === this.cfg.origin
      : origin === this.cfg.origin || (remote && this.remoteOrigin !== null && origin === this.remoteOrigin);
    if (!fromPage) { req.resume(); reply(res, 403, null, ''); return; }
    if (post && !this.cfg.allowWrite) { req.resume(); json(res, 403, { error: T('serveur à côté en lecture seule (--allow-write pour écrire)', 'read-only side server (--allow-write to write)') }); return; }
    const raw = post ? await readBody(req) : '';
    if (raw === null) { tooBig(req, res); return; }
    req.resume();
    const r = await this.peers.forward(peer.name, peer.op, post ? 'POST' : 'GET', url.searchParams.toString(), raw, header(req, 'x-sd-lang'));
    if (peer.op === 'image') res.setHeader('X-Content-Type-Options', 'nosniff');
    reply(res, r.status, r.type, r.body);
  }
  /** Ce que le serveur ajoute à l'état calculé : son démarrage, la page servie, le relais, et les autres postes. */
  #stateJson(st: object, now: number): string {
    return JSON.stringify({ ...st, server: { boot: BOOT, page: this.#pageVersion(), relay: this.cfg.primary ? this.relayHealth() : null },
      ...(this.peers.enabled ? { peers: this.peers.view(now) } : {}) });
  }

  /** Empreinte des fichiers de la page (date + taille) : la page ouverte la compare à la sienne et se recharge, après
   *  un redémarrage, quand ce qu'elle exécute n'est plus ce que le serveur sert. */
  #pageVersion(): string {
    return Object.values(PAGE).map(([f]) => { try { const st = statSync(join(this.cfg.pageDir, f)); return `${Math.round(st.mtimeMs)}.${st.size}`; } catch { return '-'; } }).join('/');
  }

  async #wait(get: () => Buffer | null, seconds: number): Promise<Buffer | null> {
    const until = nowMs() + seconds * 1000; let v: Buffer | null;
    while ((v = get()) === null && nowMs() < until) await sleep(100);
    return v;
  }

  /** Questions qu'un « Chat about this » a fermées dans le terminal de cette session (voir parked.ts). */
  #parked(pid: number): Parked | null {
    try {
      const id = psString((JSON.parse(readFileSync(join(this.d.sessionsDir, `${pid}.json`), 'utf8')) as { sessionId?: unknown }).sessionId).trim().toLowerCase();
      if (!GUID.test(id)) return null;
      const f = this.d.metaCache.get(id)?.path ?? this.d.findTranscript(id);
      return f ? parkedQuestions(f) : null;
    } catch { return null; }
  }

  #transcript(url: URL, res: ServerResponse): void {
    const id = (url.searchParams.get('id') ?? '').trim().toLowerCase();
    if (!GUID.test(id)) { json(res, 400, { error: T('identifiant de session invalide', 'invalid session id') }); return; }
    const f = this.d.metaCache.get(id)?.path ?? this.d.findTranscript(id);
    if (!f || !exists(f)) { json(res, 404, { error: T('transcript introuvable', 'transcript not found') }); return; }
    json(res, 200, readTranscript(f, url.searchParams.get('before'), url.searchParams.get('after')));
  }

  async #hook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req, 65536) ?? '';
    const sid = /"session_id"\s*:\s*"([0-9a-f-]{36})"/.exec(body); const ev = /"hook_event_name"\s*:\s*"(\w+)"/.exec(body);
    if (sid && ev && ev[1] === 'Stop' && !/"agent_id"\s*:\s*"[^"]+"/.test(body)) this.d.stops.set(sid[1]!, nowMs());
    reply(res, 200, JSON_TYPE, '');   // corps vide : aucune décision pour Claude Code
  }

  // ───────────── boucle ─────────────
  /** La boucle PowerShell : état chaque seconde (et juste après une action), fermées toutes les 15 s, surveillance
   *  toutes les 2 s ; entre deux, UNE requête de la file. */
  async loop(): Promise<void> {
    let lastState = 0, lastClosed = 0, lastWatch = 0;
    while (!this.#stopping) {
      const now = nowMs();
      if (this.#dirty || now - lastState >= 1000) {
        lastState = now;
        try {
          setPhase('état');
          const st = await this.d.state();
          void this.peers.tick(now);
          this.#state = Buffer.from(this.#stateJson(st, now)); this.beat();
          this.#firstState();
          if (!this.cfg.noBackground && now - lastWatch >= 2000) {
            lastWatch = now; setPhase('veille');
            try { await this.watch.tick(st as never); } catch { /* idem */ }
            try { this.#kickTeams(st as { sessions?: KickSession[]; teams?: unknown }, now); } catch { /* idem */ }
            if (this.cfg.primary) this.search.maybeIndex();
            this.usageProbe?.maybeRun(now);
            // Identité absente (serveur lancé avant Tailscale) : relue toutes les 30 s ; sinon `tailscale serve` chaque minute.
            if (now - this.#relayCheckedAt >= (this.remoteOrigin === null ? 30_000 : 60_000)) { void this.checkRelay(); void this.#ensureRelay(); }
          }
        } catch (e) { this.logError(`état : ${(e as Error).message}`); }
      }
      if (this.#dirty || now - lastClosed >= 15000) { lastClosed = now; setPhase('fermées'); try { this.#closed = Buffer.from(JSON.stringify(await this.d.closed())); } catch { /* idem */ } }
      this.#dirty = false;
      this.beat(); setPhase('attente');
      const item = this.#queue.shift() ?? await new Promise<Queued | undefined>((ok) => {
        const t = setTimeout(() => { this.#wake = null; ok(undefined); }, 500);
        this.#wake = () => { clearTimeout(t); this.#wake = null; ok(this.#queue.shift()); };
      });
      if (!item) continue;
      const isAction = await withLang(langOf(item.req.headers['x-sd-lang']), () => this.#process(item));
      if (isAction) this.#dirty = true;
    }
  }

  /** Le veilleur INSTALLÉ sur le poste (~/.claude/scripts/teams-watcher : c'est lui qui a le jeton) ; à défaut la copie
   *  du serveur. Ses réglages : `modules.teams` du même fichier de configuration (SD_CONFIG). */
  #watcherScript(): string {
    const installed = join(this.cfg.claude, 'scripts', 'teams-watcher', 'teams-watcher.ts');
    return exists(installed) ? installed : fileURLToPath(new URL('./teams-watcher.ts', import.meta.url));
  }
  /** Une session qu'une réponse Teams attend vient de se libérer : passe du veilleur tout de suite, détachée, au lieu
   *  d'attendre la tâche planifiée (jusqu'à 2 min). Serveur principal seul : un serveur à côté ne remet rien. */
  #kickTeams(st: { sessions?: KickSession[]; teams?: unknown }, now: number): void {
    if (!this.cfg.primary || !this.cfg.modules.teams || !Array.isArray(st.sessions)) return;
    const dir = this.d.sf('teams-waits');
    const linked = (): Set<string> => { try { return linkedPending(JSON.parse(readFileSync(join(dir, '_links.json'), 'utf8'))); } catch { return new Set(); } };
    if (!this.#kick.check(st.sessions, (st.teams ?? null) as KickSummary | null, linked, now)) return;
    spawn(process.execPath, [this.#watcherScript()], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, SD_CONFIG: this.cfg.configFile, SD_TEAMS_WAITS_DIR: dir } }).unref();
  }
  /** Envoi d'une réponse Teams par le veilleur. Texte sur stdin. */
  #teamsSend(chatId: string, text: string): Promise<string | null> {
    const script = this.#watcherScript();
    return new Promise((done) => {
      let err = '', over = false;
      const end = (v: string | null) => { if (!over) { over = true; clearTimeout(timer); done(v); } };
      const p = spawn(process.execPath, [script, 'send', chatId], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, SD_CONFIG: this.cfg.configFile, SD_TEAMS_WAITS_DIR: this.d.sf('teams-waits') } });
      const timer = setTimeout(() => { try { p.kill(); } catch { /* déjà fini */ } end(T('délai dépassé (45 s) : vérifier dans Teams avant de renvoyer', 'timed out (45 s): check in Teams before sending again')); }, 45_000);
      p.stderr.on('data', (b: Buffer) => { if (err.length < 2000) err += b.toString('utf8'); });
      p.on('error', (e) => end(T(`veilleur injoignable : ${e.message}`, `watcher unreachable: ${e.message}`)));
      p.on('close', (code) => end(code === 0 ? null : err.trim().split(/\r?\n/).pop() || T(`échec (code ${code})`, `failed (code ${code})`)));
      p.stdin.on('error', () => { /* le veilleur a fermé avant de lire */ });
      p.stdin.end(text);
    });
  }

  async #process({ req, res, path, query: q }: Queued): Promise<boolean> {
    const method = req.method ?? 'GET'; const origin = header(req, 'origin');
    const isAction = ACTIONS.has(path);
    // Les actions n'acceptent que des POST émis par la page servie ici (ou par celle du tailnet, déjà filtrée).
    const allowed = isAction ? method === 'POST' && (origin === this.cfg.origin || (this.remoteOrigin !== null && origin === this.remoteOrigin))
      : method === 'GET' && (origin === undefined || origin === this.cfg.origin);
    if (!allowed) { req.resume(); reply(res, 403, null, ''); return isAction; }
    if (isAction && !this.cfg.allowWrite) { req.resume(); json(res, 403, { error: T('serveur à côté en lecture seule (--allow-write pour écrire)', 'read-only side server (--allow-write to write)') }); return false; }
    // Corps lu UNE fois, en flux et plafonné à 1 Mo (un corps sans longueur annoncée n'est pas arrêté par la façade).
    const raw = method === 'POST' ? await readBody(req) : '';
    if (raw === null) { tooBig(req, res); return isAction; }
    let type = JSON_TYPE; let status = 200; let body: string | Buffer;
    let stopAfter = false;
    try {
      const pidQ = tryParseInt(q.get('pid'));
      const target = pidQ ?? 0;
      const knownPid = pidQ !== null && exists(join(this.d.sessionsDir, `${target}.json`));
      const payload = async (): Promise<unknown> => parseBody(raw);
      const headless = knownPid && HEADLESS_REFUSED.has(path) && (await this.d.openSessions()).some((s) => Number(s.pid) === target && s.headless);
      if (headless) { status = 409; body = JSON.stringify({ code: 4, error: T('automate sans terminal (claude -p) : il se pilote depuis son lanceur', 'automation without a terminal (claude -p): drive it from its launcher') }); }
      else if ((!this.launcher.enabled && LAUNCHER_ROUTES.has(path)) || (!this.cfg.modules.teams && TEAMS_ROUTES.has(path)) || (!this.automations.enabled && AUTOMATION_ROUTES.has(path))) { req.resume(); status = 404; body = '{}'; }
      else switch (path) {
        case '/api/state': body = this.#stateJson(await this.d.state(), nowMs()); break;
        case '/api/closed': body = JSON.stringify(await this.d.closed()); break;
        case '/api/focus':
          if (knownPid) body = JSON.stringify({ code: await this.actions.focus(target) }); else { status = 400; body = '{}'; }
          break;
        case '/api/send':
          if (knownPid) { const j = await payload(); body = JSON.stringify(await this.actions.sendFromPage(target, psString(pget(j, 'text')), psTruthy(pget(j, 'suggestion')), psTruthy(pget(j, 'force')))); }
          else { status = 400; body = '{}'; }
          break;
        case '/api/model':                                // modèle pour CETTE session seulement (menu /model, touche « s »)
          if (knownPid) { const j = await payload(); body = JSON.stringify({ error: await this.actions.sessionModel(target, psString(pget(j, 'model'))) }); }
          else { status = 400; body = '{}'; }
          break;
        case '/api/keys':
          if (knownPid) { const j = await payload(); if (!isObjBody(j)) { status = 400; body = '{}'; } else body = JSON.stringify({ error: await this.actions.keys(target, pget(j, 'keys'), psString(pget(j, 'expect'))) }); }
          else { status = 400; body = '{}'; }
          break;
        case '/api/close': if (knownPid) body = JSON.stringify(await this.actions.close(target, q.get('force') === '1')); else { status = 400; body = '{}'; } break;
        case '/api/relaunch': if (knownPid) body = JSON.stringify({ error: await this.actions.relaunch(target) }); else { status = 400; body = '{}'; } break;
        case '/api/fav': this.d.setFav(q.get('id') ?? '', q.get('on') === '1'); body = '{"ok":true}'; break;
        case '/api/tags': {                              // correction à la main (lot 3) : Set-SessionTag
          const j = await payload();
          const id = isObjBody(j) ? pget(j, 'id') : null, axis = isObjBody(j) ? pget(j, 'axis') : null, v = isObjBody(j) ? pget(j, 'v') : null;
          if (typeof id !== 'string' || typeof axis !== 'string' || typeof v !== 'string') { status = 400; body = '{}'; break; }
          const err = this.d.setTag(id, axis, v, psTruthy(pget(j, 'on')));
          if (err) { status = 400; body = JSON.stringify({ error: err }); } else body = JSON.stringify({ tags: this.d.sessionTags(id) });
          break;
        }
        case '/api/hide': { const j = await payload(); if (!isObjBody(j)) { status = 400; body = '{}'; } else body = JSON.stringify({ changed: this.d.setHidden(arr(pget(j, 'ids')), psTruthy(pget(j, 'on'))) }); break; }
        case '/api/reopen': body = JSON.stringify({ error: await this.actions.reopen(q.get('id') ?? '') }); break;
        case '/api/reopen-many': { const j = await payload(); if (!isObjBody(j)) { status = 400; body = '{}'; } else { this.d.rebootView.at = 0; body = JSON.stringify(await this.actions.reopenMany(arr(pget(j, 'ids')))); } break; }
        case '/api/reboot-dismiss': this.d.clearReboot(); body = '{"ok":true}'; break;
        case '/api/relay/restart': body = JSON.stringify(await this.restartRelay()); break;
        case '/api/test-launcher-alerts': if (this.cfg.noBackground) body = JSON.stringify({ alerts: await this.launcher.alerts({}) }); else { status = 404; body = '{}'; } break;
        case '/api/launcher': { let h = parseIntZero(q.get('hours')); if (h <= 0) h = 48; body = JSON.stringify(await this.launcher.view(Math.min(24 * 30, h))); break; }
        case '/api/launcher/hd': body = JSON.stringify(await lookupHd(q.get('hd') ?? '', process.env, this.cfg.modules.launcher)); break;
        case '/api/launcher/delivery-diff': body = JSON.stringify(await lookupDeliveryDiff(q.get('hd') ?? '', process.env, this.cfg.modules.launcher)); break;
        case '/api/launcher/cards': body = JSON.stringify(await lookupCards(q.get('hd') ?? '', process.env, this.cfg.modules.launcher)); break;
        case '/api/launcher/file': {
          const f = this.launcher.file(q.get('path') ?? '');
          if (f.status !== 404) res.setHeader('X-Content-Type-Options', 'nosniff');
          if (f.body) { type = f.type!; body = f.body; } else { status = f.status; body = '{}'; }
          break;
        }
        case '/api/automations': {                       // passes des automates du poste (module « automations »)
          const s0 = Number(q.get('since')); const now = nowMs();
          body = JSON.stringify(await this.automations.view(Number.isFinite(s0) && s0 > 0 ? Math.max(s0, now - 8 * 24 * 3600e3) : now - 24 * 3600e3));
          break;
        }
        case '/api/automations/file': {
          const f = this.automations.file(q.get('id') ?? '', q.get('run') ?? '', q.get('name') ?? '');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          if (f.body) { type = f.type!; body = f.body; } else { status = f.status; body = '{}'; }
          break;
        }
        case '/api/automations/order': {                 // « Lancer maintenant » : python <cli> <args> détaché
          const j = await payload();
          if (!isObjBody(j)) { status = 400; body = '{}'; break; }
          const r = await this.automations.order(psString(pget(j, 'id')), psString(pget(j, 'order')));
          status = r.status; body = JSON.stringify(r.body);
          break;
        }
        case '/api/send-many': { const j = await payload(); if (!isObjBody(j)) { status = 400; body = '{}'; } else body = JSON.stringify(await this.actions.sendMany(arr(pget(j, 'pids')), psString(pget(j, 'text')), psTruthy(pget(j, 'force')))); break; }
        case '/api/close-many': { const j = await payload(); if (!isObjBody(j)) { status = 400; body = '{}'; } else body = JSON.stringify(await this.actions.closeMany(arr(pget(j, 'pids')), String(pget(j, 'rule') ?? ''))); break; }
        case '/api/relaunch-many': { const j = await payload(); if (!isObjBody(j)) { status = 400; body = '{}'; } else body = JSON.stringify(await this.actions.relaunchMany(arr(pget(j, 'pids')))); break; }
        case '/api/git-refresh': {
          const s1 = knownPid ? (await this.d.openSessions()).find((s) => Number(s.pid) === target) : undefined;
          if (s1) { startGitRefresh(this.d, [s1.gitDir]).catch(() => undefined); body = '{"ok":true}'; } else { status = 400; body = '{}'; }
          break;
        }
        case '/api/commands': {                           // menu « / » de la zone de réponse : commandes de la session (ou du poste, sans pid) + raccourcis
          const s = knownPid ? (await this.d.openSessions()).find((x) => Number(x.pid) === target) : undefined;
          body = JSON.stringify({ commands: this.actions.commands.list(psString(s?.cwd)), shortcuts: this.cfg.ui.shortcuts ?? defaultShortcuts() });
          break;
        }
        case '/api/folders': body = JSON.stringify({ folders: await this.d.newFolders() }); break;
        case '/api/tag-vocab': body = JSON.stringify(this.d.tagVocab()); break;
        case '/api/teams-wait': {                        // boutons des attentes Teams (lot 2) : Invoke-TeamsWaitAction
          const j = await payload();
          if (!isObjBody(j)) { status = 400; body = '{}'; break; }
          const action = psString(pget(j, 'action')), sid = psString(pget(j, 'sessionId')), mid = psString(pget(j, 'messageId'));
          const err = ['dismiss', 'remind', 'snooze'].includes(action) && /^[\w-]+$/.test(sid) && /^\d+$/.test(mid)
            ? applyAction(this.d.sf('teams-waits'), sid, mid, action, nowMs()) : T('demande invalide', 'invalid request');
          if (!err && action === 'remind') spawn(process.execPath, [fileURLToPath(new URL('./teams-watcher.ts', import.meta.url))], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, SD_CONFIG: this.cfg.configFile, SD_TEAMS_WAITS_DIR: this.d.sf('teams-waits') } }).unref();
          this.d.teamsCache = { k: '', value: null };
          body = JSON.stringify({ error: err });
          break;
        }
        case '/api/teams-conversations': {               // vue par conversation (lot 9) : tous les chats actifs, calculée à la demande
          const v = conversationsView(this.d.sf('teams-waits'), nowMs());
          body = JSON.stringify(v ?? { at: 0, since: 0, rows: null });
          break;
        }
        case '/api/teams-thread': {                      // fil d'une conversation (lot 10) : derniers messages lus par le veilleur, en entier
          const v = conversationThread(this.d.sf('teams-waits'), q.get('chatId') ?? '');
          if (!v) { status = 404; body = '{}'; } else body = JSON.stringify(v);
          break;
        }
        case '/api/teams-reply': {                       // « Répondre » d'une conversation (lot 10) : le veilleur poste, au nom de l'utilisateur
          const j = await payload();
          if (!isObjBody(j)) { status = 400; body = '{}'; break; }
          const chatId = psString(pget(j, 'chatId')), text = psString(pget(j, 'text'));
          const err = chatId.length <= 240 && /^[\w:@.-]+$/.test(chatId) && text.trim() && text.length <= 8000
            ? await this.#teamsSend(chatId, text) : T('demande invalide', 'invalid request');
          this.d.teamsCache = { k: '', value: null };
          body = JSON.stringify({ error: err });
          break;
        }
        case '/api/teams-link': {                        // « Confier » / « Détacher » un fil (lot 11) : lien chat → session, remise par le veilleur
          const j = await payload();
          if (!isObjBody(j)) { status = 400; body = '{}'; break; }
          const action = psString(pget(j, 'action')), chatId = psString(pget(j, 'chatId')), sid = psString(pget(j, 'sessionId'));
          const dir = this.d.sf('teams-waits');
          // Facultatifs : message de référence, consigne de l'utilisateur, remise unique (sans suivre la suite du fil).
          const note = psString(pget(j, 'note'));
          const anchors = arr(pget(j, 'anchors')).map((x) => psString(x)).filter((x) => /^\d{6,24}$/.test(x)).slice(0, 20);
          const more = { ...(anchors.length ? { anchors } : {}), ...(note.trim() ? { note } : {}), ...(psTruthy(pget(j, 'once')) ? { once: true } : {}) };
          let err: string | null = T('demande invalide', 'invalid request');
          if (chatId.length <= 240 && /^[\w:@.-]+$/.test(chatId)) {
            if (action === 'detach') err = unlinkConversation(dir, chatId, nowMs());
            else if (action === 'attach' && sid === 'new') err = linkConversation(dir, chatId, randomUUID(), nowMs(), { fresh: true, ...more });
            else if (action === 'attach' && /^[\w-]{1,80}$/.test(sid)) err = linkConversation(dir, chatId, sid, nowMs(), more);
          }
          // Une passe tout de suite, détachée : la session reçoit le fil sans attendre les 2 min (si une passe tourne déjà, à la suivante).
          if (!err && action === 'attach') spawn(process.execPath, [this.#watcherScript()], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, SD_CONFIG: this.cfg.configFile, SD_TEAMS_WAITS_DIR: dir } }).unref();
          this.d.teamsCache = { k: '', value: null };
          body = JSON.stringify({ error: err });
          break;
        }
        case '/api/teams-seen': {                        // pointage « Vu » d'une conversation (ou de toutes : chatId « * »)
          const j = await payload();
          if (!isObjBody(j)) { status = 400; body = '{}'; break; }
          const action = psString(pget(j, 'action')), chatId = psString(pget(j, 'chatId')), at = Number(pget(j, 'at'));
          const err = ['seen', 'unseen'].includes(action) && chatId.length <= 240 && (chatId === '*' || /^[\w:@.-]+$/.test(chatId))
            ? markConversationSeen(this.d.sf('teams-waits'), chatId, action, at, nowMs()) : T('demande invalide', 'invalid request');
          this.d.teamsCache = { k: '', value: null };
          body = JSON.stringify({ error: err });
          break;
        }
        case '/api/launcher/order': {                    // ordre au lanceur (détail d'un run) : Invoke-LauncherOrder
          const j = await payload();
          if (!isObjBody(j)) { status = 400; body = '{}'; break; }
          this.launcher.invalidate();
          body = JSON.stringify(await runLauncherOrder(j, process.env, this.cfg.modules.launcher));
          break;
        }
        case '/api/launcher/answer': {                   // réponse à une carte de questions de l'orchestrateur (cards.ts)
          const j = await payload();
          if (!isObjBody(j)) { status = 400; body = '{}'; break; }
          const r = await answerCard(j, process.env, this.cfg.modules.launcher);
          if (r.ok === true || r.gone) { this.launcher.cards.drop(String((j as Record<string, unknown>).hd), String((j as Record<string, unknown>).card)); this.launcher.invalidate(); }
          body = JSON.stringify(r);
          break;
        }
        case '/api/find': { const qq = q.get('q') ?? ''; body = JSON.stringify(this.search.find(qq.slice(0, Math.min(200, qq.length)))); break; }
        case '/api/new': {
          const j = await payload();
          if (!isObjBody(j)) { status = 400; body = '{}'; }
          else {
            const error = await this.actions.newSession(psString(pget(j, 'cwd')), psString(pget(j, 'prompt')), psString(pget(j, 'model')), psString(pget(j, 'branch')), psString(pget(j, 'forkFrom')), pget(j, 'tags'), psString(pget(j, 'sessionId')));
            const draftId = psString(pget(j, 'draftId'));
            if (!error && draftId) this.d.drafts.remove(draftId);   // lancée depuis un brouillon : il a servi
            body = JSON.stringify({ error });
          }
          break;
        }
        case '/api/draft-save': {                         // « Enregistrer en brouillon » du formulaire Nouvelle session
          const j = await payload();
          if (!isObjBody(j)) { status = 400; body = '{}'; } else body = JSON.stringify(this.d.drafts.save(j));
          break;
        }
        case '/api/draft-delete': {
          const j = await payload();
          if (!isObjBody(j)) { status = 400; body = '{}'; } else body = JSON.stringify({ removed: this.d.drafts.remove(psString(pget(j, 'id'))) });
          break;
        }
        case '/api/ack': {
          const open = q.get('all') || knownPid ? await this.d.openSessions() : [];
          const ids = q.get('all') ? open.filter((s) => ieq(s.status, 'idle')).map((s) => s.sessionId)
            : knownPid ? open.filter((s) => Number(s.pid) === target).map((s) => s.sessionId) : [q.get('id') ?? ''];
          this.d.setSeen(ids); body = '{"ok":true}'; break;
        }
        case '/api/stop': stopAfter = true; body = '{"stopped":true}'; break;
        case '/api/test-busy':
          if (this.cfg.noBackground) { await sleep(Math.min(5000, parseIntZero(q.get('ms')))); body = '{"ok":true}'; } else { status = 404; body = '{}'; }
          break;
        default: status = 404; body = '{}';
      }
    } catch (e) {
      this.logError(`${path} : ${(e as Error).message}`);
      req.resume(); reply(res, 500, type, ''); return isAction;
    }
    req.resume();
    reply(res, status, type, body);
    if (stopAfter) void this.shutdown();
    return isAction;
  }
}

/** -not $j de PowerShell sur un corps JSON : null, faux, vide, 0, [] ⇒ 400. */
function isObjBody(j: unknown): boolean { return psTruthy(j) || (j !== null && typeof j === 'object' && !Array.isArray(j)); }
/** @($j.ids) : propriété absente ⇒ tableau vide (relevé sur le .ps1 : réouverture groupée sans ids ⇒ skipped 0). */
const arr = psArray;
/** [int]"0$x" ; lève (500) si ce n'est pas un entier, comme le .ps1. */
function parseIntZero(s: string | null): number { return psIntZero(s); }
