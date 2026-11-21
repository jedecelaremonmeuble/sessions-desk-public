// LANGUE DE LA PAGE — anglais ou français. Chaque texte affiché s'écrit T('texte français', 'English text') : les deux
// versions côte à côte, sans table de clés. Choix : ?lang=en|fr (gardé), puis le dernier choix fait dans la page, puis
// `ui.language` du fichier de configuration du poste, puis la langue du navigateur. Le serveur reçoit la langue dans
// l'en-tête X-SD-Lang de chaque appel, pour ses propres messages.
const LANG_KEY = 'cc.lang';
let LANG = (() => {
  const q = new URLSearchParams(location.search).get('lang');
  if (q === 'en' || q === 'fr') { localStorage.setItem(LANG_KEY, q); return q; }
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === 'en' || saved === 'fr') return saved;
  return /^fr\b/i.test(navigator.language || '') ? 'fr' : 'en';
})();
const T = (fr, en) => LANG === 'fr' ? fr : en;
/** Format des dates et des nombres affichés. */
const LOCALE = T('fr-FR', 'en-GB');
/** État git d'un fichier : le serveur l'écrit en français (calculé hors requête, mis en cache). */
const GIT_KIND_EN = { nouveau:'new', conflit:'conflict', supprimé:'deleted', renommé:'renamed', ajouté:'added', modifié:'modified' };
document.documentElement.lang = LANG;
{ const f = window.fetch.bind(window);
  window.fetch = (input, init = {}) => { const headers = new Headers(init.headers || {}); headers.set('X-SD-Lang', LANG); return f(input, { ...init, headers }); }; }
/** Langue du poste (ui.language), appliquée tant qu'aucun choix n'a été fait dans la page. */
function adoptPostLanguage(lang) {
  if ((lang === 'en' || lang === 'fr') && lang !== LANG && !localStorage.getItem(LANG_KEY)) { LANG = lang; location.reload(); }
}
/** Choix fait dans la page : gardé, puis la page se recharge dans cette langue. */
function setLanguage(lang) { localStorage.setItem(LANG_KEY, lang); location.reload(); }
/** Bascule de langue, dans l'en-tête de la vue d'ensemble. */
function langSwitch() {
  const b = document.createElement('button'); b.className = 'langsw';
  b.textContent = LANG === 'fr' ? '🌐 English' : '🌐 Français';
  b.title = LANG === 'fr' ? 'Afficher la page en anglais' : 'Show the page in French';
  b.onclick = () => setLanguage(LANG === 'fr' ? 'en' : 'fr');
  return b;
}

/** Textes fixes de index.html (écrits en français dans le fichier) : traduits au chargement. */
function applyStaticText() {
  const set = (id, attr, fr, en) => { const e = document.getElementById(id); if (e) { if (attr) e.setAttribute(attr, T(fr, en)); else e.textContent = T(fr, en); } };
  document.title = T('Sessions Claude Code', 'Claude Code sessions');
  document.querySelector('.sidehead h1').textContent = T('Sessions Claude Code', 'Claude Code sessions');
  set('resizer', 'title', 'Glisser pour redimensionner · double-clic : largeur par défaut', 'Drag to resize · double-click: default width');
  set('q', 'placeholder', 'Rechercher…  ( / )', 'Search…  ( / )');
  set('q', 'title', 'Titre, prompt, numéro de PR, dossier, identifiant', 'Title, prompt, PR number, folder, id');
  set('favonly', 'title', "N'afficher que les favoris", 'Show favourites only');
  set('sortbtn', 'title', 'Ordre dans chaque groupe : dernière activité ou date de création', 'Order within each group: last activity or creation date');
  set('bell', 'title', 'Notifications récentes', 'Recent notifications');
  set('chatsbtn', 'title', "Conversations Teams : tous tes chats actifs, ceux où c'est à toi de répondre, ceux à voir  ( m )", 'Teams conversations: all your active chats, the ones waiting for your reply, the ones to look at  ( m )');
  set('launchbtn', 'title', 'Lanceur (diagnostic auto) : runs en cours, tickets qui attendent, runs récents  ( l )', 'Launcher (automatic diagnosis): running runs, waiting tickets, recent runs  ( l )');
  set('boardbtn', 'title', 'Tableau par projet : à cadrer → en cours → en recette → à merger → livré  ( t )', 'Board by project: to scope → in progress → in review → to merge → shipped  ( t )');
  set('bcbtn', 'title', 'Écrire le même message à plusieurs sessions', 'Send the same message to several sessions');
  set('newbtn', 'title', 'Lancer une nouvelle session  ( + )', 'Start a new session  ( + )');
  set('cfgbtn', 'title', 'Configuration du poste (config.json)', 'Configuration of this machine (config.json)');
  set('cfgcheck', '', 'Vérifier', 'Check'); set('cfgsave', '', 'Enregistrer', 'Save'); set('cfgclose', '', 'Fermer', 'Close');
  set('cfgtitle', '', 'Configuration du poste', 'Configuration of this machine');
  set('mfind', 'title', 'Afficher les passages trouvés dans les conversations', 'Show the matches found in conversations');
  set('mfind', null, 'Passages trouvés dans les conversations →', 'Matches found in conversations →');
  set('mback', 'title', 'Revenir à la liste des sessions  ( Échap )', 'Back to the session list  ( Esc )');
  set('mback', null, '← Sessions', '← Sessions');
}
applyStaticText();
// Bascule de langue toujours visible, en tête de la colonne des sessions : 🌐 + la langue VERS laquelle on bascule.
{ const b = document.getElementById('langtop');
  if (b) { b.textContent = LANG === 'fr' ? '🌐 EN' : '🌐 FR'; b.title = LANG === 'fr' ? 'Afficher la page en anglais (English)' : 'Show the page in French (Français)'; b.onclick = () => setLanguage(LANG === 'fr' ? 'en' : 'fr'); } }

const LABEL = { waiting:T('bloquée sur une question', 'waiting on a question'), ask:T('attend ta décision', 'waiting for your decision'), done:T('terminé, à relire', 'done, to review'), busy:T('travaille', 'working'), shell:T('attend sa commande en arrière-plan', 'waiting on a background command'), idle:T('inactive', 'idle'), auto:T('automate sans terminal (claude -p)', 'automation without a terminal (claude -p)'), teams:T('attend un retour Teams', 'waiting for a Teams reply'), closed:T('fermée', 'closed') };
const GROUPS = [
  { key:'todo',   title:T('À traiter', 'To handle'),  states:['waiting','ask','done'], asc:true },
  { key:'work',   title:T('Au travail', 'Working'), states:['busy','shell'] },
  // Sessions dont le tour est fini (ou fermées) et qui attendent la réponse d'un collègue sur Teams : rien à faire tant
  // qu'il n'a pas répondu (le veilleur injecte la réponse et la session repart seule). Voir teamsHeld.
  { key:'teams',  title:T('⏳ Attente Teams', '⏳ Waiting on Teams'), states:['teams'] },
  { key:'idle',   title:T('Inactives', 'Idle'),  states:['idle'] },
  // Runs du lanceur du jour (+ en cours) et autres claude -p lancés par un script : suivis ici, pas pilotables d'ici.
  // Replié, le groupe garde visibles les runs en cours, en échec et ceux qui attendent l'utilisateur.
  { key:'auto',   title:T('🤖 Lanceur', '🤖 Launcher'), states:['auto'] },
  { key:'closed', title:T('Fermées, reprenables', 'Closed, reopenable'), states:['closed'] } ];
let data = null, closedData = { days:0, closed:[] }, flat = [], notice = null, lastScreen = null, detailKey = null;
let favs = new Set(), favOnly = localStorage.getItem('cc.favonly') === '1';
// Ordre dans chaque groupe : 'activity' (dernier changement d'état, par défaut) ou 'created' (création de la session, la plus
// récente d'abord). createdAt vient du serveur (1er horodatage du transcript) ; un run du lanceur n'en a pas : son début.
let sortMode = localStorage.getItem('cc.sort') === 'created' ? 'created' : 'activity';
const createdOf = it => it.createdAt || it.startedAt || it.at || it.since || 0;
let selected = new URLSearchParams(location.search).get('sel') || sessionStorage.getItem('cc.sel');   // ?sel=<sessionId> : lien direct
let collapsed = new Set(JSON.parse(localStorage.getItem('cc.collapsed') || '["closed"]'));
if (!localStorage.getItem('cc.autoGroup')) { collapsed.add('auto'); localStorage.setItem('cc.autoGroup', '1'); localStorage.setItem('cc.collapsed', JSON.stringify([...collapsed])); }   // replié par défaut
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const ago = ms => { const s = Math.max(0, Math.round(ms/1000)); if (s < 60) return s + ' s'; const m = Math.floor(s/60); if (m < 60) return m + ' min'; const h = Math.floor(m/60); return h < 48 ? h + ' h ' + String(m%60).padStart(2,'0') : Math.floor(h/24) + T(' j', ' d'); };
// « Au travail » comme dans le terminal Claude Code : « ✻ Pondering… (1m 5s · ↓ 1.2k tokens) ». Le verbe et les tokens
// viennent de l'écran de la session (état : spin) ; le chrono avance seul, à la seconde (minuteur en bas du fichier).
const spinDur = ms => { const s = Math.max(0, Math.floor(ms/1000)); if (s < 60) return s + 's'; const m = Math.floor(s/60); return m < 60 ? m + 'm ' + (s%60) + 's' : Math.floor(m/60) + 'h ' + (m%60) + 'm'; };
let skew = 0;   // horloge de la page - horloge du serveur (data.now)
const spinPhase = () => document.documentElement.style.setProperty('--sd-ph', -Math.round(performance.now() % 12000) + 'ms');
const spinVerb = it => el('span', 'spinv', (it.spin && it.spin.verb || T('Travaille', 'Working')) + '…');
const spinMeta = m => '(' + spinDur(Date.now() - skew - Number(m.dataset.since)) + (m.dataset.tk ? ' · ' + m.dataset.tk + ' tokens' : '') + ')';
function spinLabel(it) {
  const m = el('span', 'spinm'); m.dataset.since = it.since; m.dataset.tk = it.spin && it.spin.tokens || ''; m.textContent = spinMeta(m);
  const f = document.createDocumentFragment(); f.append(spinVerb(it), ' ', m); return f;
}
const ktok = n => n == null ? '' : n < 1000 ? String(n) : Math.round(n / 1000) + ' k';
// « claude-opus-5-5 » → « Opus 5.5 », « claude-fable-5-2[1m] » → « Fable 5.2 1M » ; un id inconnu s'affiche tel quel.
const modelName = m => { if (!m) return ''; const x = /^claude-([a-z]+)-(\d{1,2})-(\d{1,2})(?!\d)/.exec(m); return x ? x[1][0].toUpperCase() + x[1].slice(1) + ' ' + x[2] + '.' + x[3] + (m.includes('[1m]') ? ' 1M' : '') : m.replace(/^claude-/, ''); };
// Réglages d'affichage du poste (data.ui : préfixe de chemin à ne pas répéter, adresses des PR et des tickets).
const ui = () => (data && data.ui) || {};
// Coût relatif du modèle (data.ui.models : table de config.json, ou table publique par défaut) — la première entrée
// dont `match` figure dans l'identifiant. Repère : l'entrée à 1 (Opus par défaut).
const modelCost = m => { if (!m) return null; const id = m.toLowerCase(); return (ui().models || []).find(e => id.includes(e.match)) || null; };
const costRef = () => ((ui().models || []).find(e => e.cost === 1) || { label: T('la référence', 'the reference') }).label;
// Seuils du quota (ui.quota du poste, 75 / 90 % par défaut) : orange à `warn`, rouge à `alert`.
const qLevel = (pct, low) => { const q = ui().quota || { warn: 75, alert: 90 }; return pct >= q.alert ? 'waiting' : pct >= q.warn ? 'ask' : low; };
const costFactor = c => '×' + c.toLocaleString(LOCALE, { maximumFractionDigits: c < 0.1 ? 3 : 2 });
/** Pastille du modèle, colorée par coût : orange plein = plus cher que la référence, discrète = référence, verte = moins
 *  cher, pointillée = inconnu de la table. `compact` (liste) : nom + multiplicateur seuls ; sinon « vs <référence> ». */
function modelBadge(m, compact, extra) {
  const c = modelCost(m), lvl = !c ? 'unk' : c.cost >= 1.2 ? 'hi' : c.cost > 0.85 ? 'std' : 'lo', ref = costRef();
  const b = el('span', 'mdl ' + lvl);
  const f = c && c.cost !== 1 ? costFactor(c.cost) : '';
  b.textContent = (lvl === 'hi' ? '💰 ' : '') + modelName(m) + (f ? (compact ? ' ' + f : ' · ' + f + ' vs ' + ref) : '');
  b.title = m + '\n' + (!c ? T('Coût inconnu : ajouter une entrée « ui.models » dans config.json.', 'Unknown cost: add a "ui.models" entry in config.json.')
    : (c.cost === 1 ? T('Modèle de référence pour les coûts', 'Reference model for costs')
      : T((c.cost > 1 ? 'Coûte ' : 'Coûte seulement ') + f + ' par rapport à ' + ref, 'Costs ' + f + ' compared with ' + ref)
        + '\n' + T('Sur un abonnement : épuise le quota ' + f + (c.cost > 1 ? ' plus vite' : ''), 'On a subscription: uses up the quota ' + f + (c.cost > 1 ? ' faster' : '')))
      + (c.note ? '\n' + T('Tarif API (entrée / sortie, par million de tokens) : ', 'API price (input / output, per million tokens): ') + c.note : '')
      + '\n' + T('Table : « ui.models » de config.json', 'Table: "ui.models" in config.json'))
    + (extra ? '\n' + extra : '');
  return b;
}
// config.json illisible : tous les modules sont éteints — le dire en tête de la liste, avec la cause.
// État du fichier de configuration, en tête de la liste : illisible (tout est éteint au démarrage, ou les réglages
// d'avant sont gardés s'il l'est devenu en cours de route), modifié d'une façon qui attend un redémarrage, réglages ignorés.
function cfgErr(msg, warnings, kept, restart) {
  const e = $('cfgerr'); if (!e) return;
  const w = Array.isArray(warnings) ? warnings.filter(x => typeof x === 'string') : [];
  const r = Array.isArray(restart) ? restart.filter(x => typeof x === 'string') : [];
  const key = [msg || '', kept ? 1 : 0, r.join(','), w.join('\n')].join('\n'); if (e.dataset.k === key) return; e.dataset.k = key;
  e.hidden = !msg && !w.length && !r.length; e.classList.toggle('warn', !msg); e.textContent = '';
  const line = (t) => { const d = document.createElement('div'); d.textContent = t; e.appendChild(d); };
  if (msg && kept) line(T('⚠ Fichier de configuration illisible : les réglages d’avant restent en service. Corriger le fichier, il est relu tout seul. — ', '⚠ Configuration file unreadable: the previous settings stay in effect. Fix the file; it is read again on its own. — ') + msg);
  else if (msg) { line(T('⚠ Fichier de configuration illisible : tout est éteint (lanceur, Teams, quota, tags). Corriger puis redémarrer le serveur. — ', '⚠ Configuration file unreadable: everything is off (launcher, Teams, quota, tags). Fix it, then restart the server. — ') + msg); return; }
  if (r.length) line(T('↻ config.json modifié : redémarrer le serveur pour appliquer ', '↻ config.json changed: restart the server to apply ') + r.join(', '));
  if (!w.length) return;
  const d = document.createElement('details'), sm = document.createElement('summary'), ul = document.createElement('ul');
  sm.textContent = w.length === 1 ? T('⚠ config.json : 1 réglage ignoré', '⚠ config.json: 1 setting ignored') : T(`⚠ config.json : ${w.length} réglages ignorés`, `⚠ config.json: ${w.length} settings ignored`);
  for (const x of w) { const li = document.createElement('li'); li.textContent = x; ul.appendChild(li); }
  d.append(sm, ul); e.appendChild(d);
}
const short = p => { const s = p || '', pre = ui().pathPrefix || ''; return (pre && s.toLowerCase().startsWith(pre.toLowerCase()) ? s.slice(pre.length).replace(/^[\\/]+/, '') : s) || s; };
const norm = t => (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
// Lien avec le serveur (voir tick) : déclaré tôt, post() et l'envoi le lisent.
const link = { boot: null, page: null, down: null, reload: false };   // down : { since, tries, why } pendant une coupure
let ticking = false;
const say = t => { notice = t; $('live').textContent = t; setTimeout(() => { if (notice === t) notice = null; }, 5000); };
const label = it => it.title || it.name || String(it.pid || it.sessionId.slice(0, 8));
// Une session qui a fini son tour « demande » quelque chose si la fin de son dernier message est une
// question ou sollicite un accord. Simple heuristique : sinon elle est « terminé, à relire ».
const tailOf = r => (r || '').trim().split(/\n\s*\n/).slice(-2).join('\n');
// Aussi la consigne à dire entre guillemets (« Dis « envoie » et je le poste », « Réponds « go » ») : sans elle, une
// session qui attend ce mot finissait « à relire », donc rangée dans ⏳ Attente Teams quand elle avait aussi écrit à
// un collègue — invisible alors que c'est à toi de jouer.
const asks = r => { const t = tailOf(r); return /\?\s*$/m.test(t) || /\b(le go|ton go|votre go|ton accord|votre accord|feu vert|dis-moi|dites-moi|donne-moi|donnez-moi|veux-tu|voulez-vous|souhaites-tu|souhaitez-vous|à toi de|à vous de|dès que tu|j'attends ton|j'attends ta|let me know|should i)\b/i.test(t)
  || /(^|[^\p{L}])(dis|dites|réponds|répondez|tape|tapez|écris|écrivez|say|reply|type)\s*[«"“]/iu.test(t); };
const lastLine = r => { const l = (r || '').split('\n').map(x => x.trim()).filter(Boolean); return l.length ? l[l.length - 1].replace(/[*`#]/g, '') : ''; };
const TODO = ['waiting', 'ask', 'done'];

// ── Quota des comptes Claude ──
// Relevé par le collecteur du lanceur toutes les 5 min (data.quota, dates en ms). Fonction pure, testée par
// sessions-dashboard-tests.ps1 : % de la semaine, part de la semaine écoulée, écart au rythme régulier, budget par jour
// jusqu'à la remise, rythme récent (déduit de la projection du collecteur, faite sur les 30 dernières heures).
const WEEK = 7 * 864e5, DAY = 864e5;
function quotaView(q, now) {
  const v = { alias: q.alias || '', active: !!q.active, status: q.status || '', pct: q.weeklyPct ?? null, projected: q.weeklyProjectedPct ?? null, age: q.measuredAt ? now - q.measuredAt : null };
  v.ok = v.pct != null;
  v.expired = !!(q.weeklyResetsAt && q.weeklyResetsAt <= now);                 // remise passée : le relevé ne vaut plus
  v.stale = v.expired || (v.age != null && v.age > 30 * 60000) || (!!v.status && v.status !== 'ok');
  if (q.weeklyResetsAt && !v.expired) { v.reset = q.weeklyResetsAt; v.elapsed = Math.min(100, Math.max(0, 100 * (now - (v.reset - WEEK)) / WEEK)); }
  if (v.ok && v.elapsed != null && !v.expired) {
    v.pace = Math.round(v.pct - v.elapsed);                                     // > 0 : consommé plus vite qu'un rythme régulier
    const days = Math.max(1 / 24, (v.reset - now) / DAY);
    v.budgetPerDay = Math.max(0, 100 - v.pct) / days;                           // ce qu'on peut dépenser par jour sans atteindre 100 %
    if (v.projected != null && v.projected >= v.pct) v.recentPerDay = (v.projected - v.pct) / days;
  }
  v.fullAt = q.weeklyFullAt && q.weeklyFullAt > now && (!v.reset || q.weeklyFullAt < v.reset) && !v.expired ? q.weeklyFullAt : null;
  // Limite propre à un modèle (« Fable ») : même semaine que la limite globale, sa barre porte le même repère.
  v.models = (q.limits || []).filter(l => l.model && l.pct != null).map(l => {
    const reset = l.resetsAt && l.resetsAt > now ? l.resetsAt : null;
    return { name: l.model, pct: l.pct, reset, elapsed: reset ? Math.min(100, Math.max(0, 100 * (now - (reset - WEEK)) / WEEK)) : v.elapsed ?? null,
             level: v.expired ? 'idle' : qLevel(l.pct, 'busy') };
  });
  v.fiveHour = q.fiveHourPct != null ? { pct: q.fiveHourPct, reset: q.fiveHourResetsAt || null } : null;
  v.level = !v.ok || v.expired ? 'idle' : v.fullAt && qLevel(v.pct, 'busy') === 'busy' ? 'ask' : qLevel(v.pct, 'busy');
  return v;
}
const PLAN_FR = p => { const m = /max_(\d+)x/i.exec(p || ''); return m ? 'Max ' + m[1] + 'x' : /pro/i.test(p || '') ? 'Pro' : (p || '').replace(/^default_claude_/, ''); };
const atFr = ms => new Date(ms).toLocaleString(LOCALE, { weekday:'short', hour:'2-digit', minute:'2-digit' });
const inFr = ms => { const m = Math.max(0, Math.round(ms / 60000)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60); return d ? d + T(' j ', ' d ') + h + ' h' : h ? h + ' h ' + String(m % 60).padStart(2, '0') : m + ' min'; };
// Compte à rebours court de la ligne de quota (« ↻ 4 j ») : jours entiers s'il en reste au moins un, sinon heures, puis minutes.
const leftFr = ms => { const m = Math.max(0, Math.floor(ms / 60000)), d = Math.floor(m / 1440), h = Math.floor(m / 60);
  return d ? d + T(' j', ' d') : h ? h + ' h' : m + ' min'; };
const pts = n => (n > 0 ? '+' : '') + n + ' pt' + (Math.abs(n) > 1 ? 's' : '');
const quotas = () => ((data && data.quota) || []).map(q => quotaView(q, Date.now()));
function quotaBar(v) {
  const b = el('div', 'qbar ' + v.level); const f = el('i'); f.style.width = Math.min(100, v.pct || 0) + '%'; b.append(f);
  if (v.elapsed != null) { const m = el('u'); m.style.left = v.elapsed + '%'; m.title = T(Math.round(v.elapsed) + ' % de la semaine écoulée', Math.round(v.elapsed) + '% of the week elapsed'); b.append(m); }
  return b;
}
// MODE DÉGRADÉ des propositions de prompt. Claude Code cesse d'en générer dès que le quota n'est plus « allowed »
// (une limite active en alerte : severity autre que normal) — sauf si CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION est forcée
// (data.promptSuggestion.forced, lue dans ~/.claude/settings.json) ; quota épuisé : plus rien dans tous les cas.
// Sans cette ligne, la ligne 💡 disparaît de la liste sans explication. Pure : (data.quota, data.promptSuggestion, now).
// Seul le compte CONNECTÉ compte : c'est son quota que voient les sessions — un autre compte à 100 % ne coupe rien.
// Compte connecté inconnu (aucun relevé marqué active) : on retombe sur tous les comptes.
function suggestionMode(quota, setting, now) {
  const ok = (quota || []).filter(q => q.status === 'ok'), mine = ok.some(q => q.active) ? ok.filter(q => q.active) : ok;
  const lims = mine.flatMap(q => (q.limits || []).map(l => ({ ...l, reset: l.resetsAt || q.weeklyResetsAt || null })))
    .filter(l => l.active && (!l.reset || l.reset > now));
  const full = lims.filter(l => l.pct != null && l.pct >= 100), warn = lims.filter(l => l.severity && l.severity !== 'normal');
  if (!full.length && !warn.length) return null;
  const back = Math.max(...(full.length ? full : warn).map(l => l.reset || 0)) || null;
  const forced = !!(setting && setting.forced);
  if (full.length) return { level: 'waiting', text: T('💡 mode dégradé : quota épuisé, plus de proposition de prompt', '💡 degraded mode: quota used up, no more prompt suggestions'), back,
    tip: T('Une limite est à 100 % : Claude Code ne génère aucune proposition, même forcée.', 'A limit is at 100%: Claude Code generates no suggestion, even when forced.') };
  if (forced) return { level: 'ask', text: T('💡 mode dégradé : propositions forcées', '💡 degraded mode: suggestions forced'), back,
    tip: T('Quota en alerte : Claude Code couperait les propositions, CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION les force (elles consomment un peu de quota).', 'Quota warning: Claude Code would turn suggestions off, CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION forces them (they use a little quota).')
      + (setting.since ? T('\nRéglage posé ' + atFr(setting.since) + ' : une session ouverte avant ne le voit qu’après redémarrage.', '\nSetting applied ' + atFr(setting.since) + ': a session opened before only sees it after a restart.') : '') };
  return { level: 'waiting', text: T('💡 mode dégradé : Claude Code ne propose plus de prompt', '💡 degraded mode: Claude Code no longer suggests prompts'), back,
    tip: T('Quota en alerte : Claude Code ne génère plus de proposition de prompt (ligne 💡 de la liste vide).\nPour les garder : CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=true dans le bloc env de ~/.claude/settings.json (nouvelles sessions).', 'Quota warning: Claude Code no longer generates prompt suggestions (the 💡 line of the list is empty).\nTo keep them: CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=true in the env block of ~/.claude/settings.json (new sessions).') };
}
// Bandeau compact de la barre latérale : un compte par ligne (le nom seulement s'il y en a plusieurs).
function renderQuota() {
  const box = $('quota'); if (!box) return;
  const vs = quotas().filter(v => v.ok);
  const sm = suggestionMode(data && data.quota, data && data.promptSuggestion, Date.now());
  const sig = vs.map(v => [v.alias, v.pct, v.level, v.fullAt, v.stale, Math.round(v.elapsed || 0), v.reset ? leftFr(v.reset - Date.now()) : '', v.models.map(m => m.name + '=' + m.pct + m.level).join(',')].join(':')).join('|') + '|' + (sm ? sm.text + sm.back : '');
  const sigA = sig + '|' + vs.map(v => v.active ? 1 : 0).join('');           // compte connecté : la mise en avant suit la bascule /login
  if (box.dataset.sig === sigA) return; box.dataset.sig = sigA; box.replaceChildren();
  for (const v of vs) {
    const d = el('div', 'qline' + (v.stale ? ' stale' : '') + (v.active && vs.length > 1 ? ' active' : ''));
    d.title = T('Quota hebdomadaire Claude', 'Claude weekly quota') + (vs.length > 1 ? ' — ' + v.alias : '') + (v.active ? T(' (compte connecté, celui que consomment les sessions)', ' (signed-in account, the one sessions use)') : '') + T(' · cliquer : détail dans la vue d\'ensemble', ' · click: details in the overview');
    const txt = el('span', 'qt');
    txt.append(el('b', null, Math.round(v.pct) + ' %'), (vs.length > 1 ? ' ' + v.alias.split('@')[0] : T(' semaine', ' week')));   // plusieurs comptes : le nom prend la place de « semaine » (dit par l'infobulle)
    // Bandeau étroit : toujours le compte à rebours jusqu'à la remise, orange si le quota sera plein avant ; les dates en infobulle.
    const info = v.expired ? T('relevé d\'avant la remise', 'reading from before the reset') : v.reset ? '↻ ' + leftFr(v.reset - Date.now()) : '';
    const qx = el('span', 'qx' + (v.fullAt ? ' warn' : ''), info);
    if (v.reset && !v.expired) qx.title = T('Remise du quota ', 'Quota reset ') + atFr(v.reset) + (v.fullAt ? T(' · 100 % atteint ', ' · 100% reached ') + atFr(v.fullAt) : '');
    const main = el('div', 'qcell'); main.append(txt, qx, quotaBar(v)); d.append(main);
    for (const m of v.models) {                                                 // même ligne : une barre par modèle limité à part
      const mc = el('div', 'qcell'), mt = el('span', 'qt'); mt.append(el('b', null, Math.round(m.pct) + ' %'), ' ' + m.name);
      mc.title = T('Quota hebdomadaire propre au modèle ' + m.name, 'Weekly quota of the ' + m.name + ' model');
      mc.append(mt, el('span', 'qx'), quotaBar(m)); d.append(mc);
    }
    d.onclick = () => { findMode = newMode = bcMode = boardMode = chatsMode = false; if (launchMode) closeLauncher(); selected = null; sessionStorage.removeItem('cc.sel'); renderList(); renderDetail(true); };
    box.append(d);
  }
  if (sm) {
    const d = el('div', 'qdeg ' + sm.level); d.title = sm.tip;
    d.append(el('span', null, sm.text), el('span', 'qx', sm.back ? T('retour ', 'back ') + atFr(sm.back) : ''));
    box.append(d);
  }
}
// Détail dans la vue d'ensemble.
function quotaSection() {
  const vs = quotas(); if (!vs.length) return null;
  const box = el('div', 'qcards');
  for (const v of vs) {
    const c = el('div', 'qcard ' + v.level + (v.active && vs.length > 1 ? ' active' : ''));
    const h = el('div', 'qhead'); h.append(el('b', null, v.ok ? Math.round(v.pct) + ' %' : '—'), el('span', null, v.alias + (data.quota.find(q => q.alias === v.alias)?.plan ? ' · ' + PLAN_FR(data.quota.find(q => q.alias === v.alias).plan) : '') + (v.active && vs.length > 1 ? T(' · connecté', ' · signed in') : '')));
    c.append(h);
    if (v.ok) {                                                                 // barres côte à côte : tous modèles, puis chaque modèle limité à part
      const row = el('div', 'qrow');
      const cell = (pct, label, bar) => { const x = el('div', 'qcell'), t = el('div', 'qmodel'); t.append(el('b', null, Math.round(pct) + ' %'), el('span', null, label)); x.append(t, bar); return x; };
      if (v.models.length) { row.append(cell(v.pct, T('tous modèles', 'all models'), quotaBar(v))); for (const m of v.models) row.append(cell(m.pct, T('modèle ' + m.name, m.name + ' model'), quotaBar(m))); c.append(row); }
      else c.append(quotaBar(v));
    }
    const lines = [];
    if (!v.ok) lines.push([T('pas de mesure', 'no measurement'), v.status || T('aucun relevé', 'no reading')]);
    if (v.expired) lines.push([T('remise', 'reset'), T('passée depuis le relevé — en attente d\'une nouvelle mesure', 'passed since the reading — waiting for a new measurement')]);
    else if (v.reset) lines.push([T('remise', 'reset'), T('dans ' + inFr(v.reset - Date.now()) + ' (' + atFr(v.reset) + ')', 'in ' + inFr(v.reset - Date.now()) + ' (' + atFr(v.reset) + ')')]);
    if (v.pace != null) lines.push([T('rythme', 'pace'), T(Math.round(v.elapsed) + ' % de la semaine écoulée · ' + (v.pace === 0 ? 'pile dans le rythme régulier' : pts(v.pace) + (v.pace > 0 ? ' au-dessus' : ' sous') + ' du rythme régulier'), Math.round(v.elapsed) + '% of the week elapsed · ' + (v.pace === 0 ? 'exactly on a steady pace' : pts(v.pace) + (v.pace > 0 ? ' above' : ' below') + ' a steady pace'))]);
    if (v.budgetPerDay != null) lines.push([T('budget', 'budget'), T(Math.round(v.budgetPerDay) + ' %/jour jusqu\'à la remise' + (v.recentPerDay != null ? ' · rythme des 30 dernières heures : ' + Math.round(v.recentPerDay) + ' %/jour' : ''), Math.round(v.budgetPerDay) + '%/day until the reset' + (v.recentPerDay != null ? ' · pace over the last 30 hours: ' + Math.round(v.recentPerDay) + '%/day' : ''))]);
    if (v.projected != null && !v.expired) lines.push([T('projection', 'projection'), T(Math.round(v.projected) + ' % à la remise' + (v.fullAt ? ' — 100 % atteint ' + atFr(v.fullAt) + ' (dans ' + inFr(v.fullAt - Date.now()) + ')' : ''), Math.round(v.projected) + '% at the reset' + (v.fullAt ? ' — 100% reached ' + atFr(v.fullAt) + ' (in ' + inFr(v.fullAt - Date.now()) + ')' : ''))]);
    if (v.fiveHour) lines.push([T('fenêtre 5 h', '5 h window'), Math.round(v.fiveHour.pct) + ' %' + (v.fiveHour.reset ? T(' · remise ', ' · reset ') + atFr(v.fiveHour.reset) : '')]);
    if (v.age != null) lines.push([T('relevé', 'reading'), T('il y a ' + ago(v.age), ago(v.age) + ' ago') + (v.status && v.status !== 'ok' ? T(' · dernière tentative : ', ' · last attempt: ') + v.status : '') + (v.stale && !v.expired && v.status === 'ok' ? T(' — le collecteur du lanceur tourne-t-il ?', ' — is the launcher collector running?') : '')]);
    const dl = el('dl'); for (const [k, x] of lines) dl.append(el('dt', null, k), el('dd', null, x)); c.append(dl);
    box.append(c);
  }
  return box;
}
// « shell » (tour fini, commande en arrière-plan) : si son dernier message te pose une question, c'est à toi ;
// sinon elle attend sa commande et reprendra seule.
// « Attend ta décision ? » : l'heuristique OU le petit modèle (askVerdict, rendu par le serveur quelques secondes après la
// fin du tour, asks-judge.ts). L'heuristique se trompe rarement quand elle dit oui ; le modèle rattrape les formes qu'elle
// ne connaît pas (« when you give the go », « je peux regarder… », un essai à faire).
const asksOf = it => asks(it.reply) || !!(it.askVerdict && it.askVerdict.v);
const stateOf = it => it.kind === 'closed' ? 'closed' : it.kind === 'pass' ? 'auto:' + it.auto.id : it.kind === 'run' && it.cards && it.cards.length && !it.run.running ? 'ask' : it.kind === 'run' || it.headless ? 'auto' : it.status === 'idle' ? (it.done ? (asksOf(it) ? 'ask' : 'done') : 'idle')
  : it.status === 'shell' ? (asksOf(it) ? 'ask' : 'shell') : (LABEL[it.status] ? it.status : 'idle');
function prTags(it) {
  const p = it.prInfo; if (!p || !it.pr) return [];
  const out = [p.state === 'MERGED' ? el('span', 'tag merged', T('mergée', 'merged')) : p.state === 'CLOSED' ? el('span', 'tag closedpr', T('fermée sans merge', 'closed without merge')) : el('span', 'tag ' + (p.draft ? 'draft' : 'open'), p.draft ? T('brouillon', 'draft') : T('ouverte', 'open'))];
  if (p.state === 'OPEN' && p.checks) out.push(el('span', 'tag ' + p.checks, p.checks === 'ok' ? T('CI verte', 'CI green') : p.checks === 'ko' ? T('CI rouge', 'CI red') : T('CI en cours', 'CI running')));
  return out;
}

// ── Sessions des AUTRES POSTES du propriétaire (clé `peers` de config.json, `data.peers` dans l'état) ──
// Elles entrent dans la même liste, sous le genre « peer » et non « open » : tout ce qui agit sur le poste d'ici par
// numéro de process (fermer, relancer, envoi groupé, onglet) teste « open » et les ignore donc d'office — un pid d'un
// autre poste peut être celui d'une session d'ici. Ce qui leur est permis est nommé une à une : lire l'écran et la
// conversation, répondre, répondre à un dialogue. PURES (testées).
const isLive = it => !!it && (it.kind === 'open' || it.kind === 'peer');
// Chemin à appeler pour cette session : le relais du serveur quand elle vit sur un autre poste.
const sx = (it, path) => it && it.machine ? '/api/peer/' + encodeURIComponent(it.machine) + path.slice(4) : path;
/** Clé du menu « / » : le pid, précédé du poste quand ce n'est pas celui-ci. */
const cmdKey = it => !it ? '' : it.machine ? it.machine + ':' + it.pid : it.pid;
function peerItems(peers, localIds) {
  const out = [];
  for (const p of peers || []) if (p && p.ok) for (const s of p.sessions || []) if (s && s.sessionId && !localIds.has(s.sessionId)) out.push({ ...s, kind:'peer', machine: p.name, key: s.sessionId, since: s.statusSince });
  return out;
}
/** Postes configurés qui ne répondent pas : une ligne chacun en tête de liste. */
const peersDown = peers => (peers || []).filter(p => p && !p.ok);
/** Page du poste qui porte la session (pour ce qui ne se fait que là-bas) ; null si l'adresse de ce poste est inconnue. */
function peerPage(selfUrl, it) {
  const m = /^https:\/\/[^./]+\.([^/]+)$/.exec(selfUrl || '');
  return m && it && it.machine ? 'https://' + it.machine + '.' + m[1] + '/?sel=' + encodeURIComponent(it.sessionId) : null;
}

function allItems() {
  if (!data) return [];
  const rg = runGroup();          // runs du lanceur : la session headless d'un run en cours est absorbée par lui
  const ag = autoGroup();         // passes des automates : idem pour la passe en cours
  const open = data.sessions.filter(s => !rg.absorbed.has(s.sessionId) && !ag.absorbed.has(s.sessionId)).map(s => ({ ...s, kind:'open', key:s.sessionId, since:s.statusSince }));
  const ids = new Set(data.sessions.map(s => s.sessionId));
  const runIds = new Set(rg.items.flatMap(it => it.runs || [it]).concat(ag.items).map(it => it.sessionId).filter(Boolean));     // un run « ↻ repris » n'est pas aussi une fermée
  const closed = closedData.closed.filter(c => !ids.has(c.sessionId) && !runIds.has(c.sessionId)).map(c => ({ ...c, kind:'closed', key:c.sessionId, since:c.lastActivity }));
  return open.concat(peerItems(data.peers, ids), closed, rg.items, ag.items).map(it => ({ ...it, state: teamsHeld(stateOf(it), teamsWaitsOf(it)) ? 'teams' : stateOf(it), fav: favs.has(it.key), hidden: it.kind === 'closed' && hiddenSet.has(it.key),
    hay: norm([it.title, it.name, it.pr ? '#' + it.pr + ' pr ' + it.pr : '', it.sessionId, it.cwd, it.reply, it.suggestion, it.outcome, it.run ? (it.runs || [it]).map(x => x.run.phase + ' ' + (x.run.detail || '')).join(' ') : '', it.kind === 'pass' ? it.auto.label + ' ' + (it.pass ? it.pass.summary + ' ' + (PASS_FR[it.pass.status] || '') : T('en cours', 'running')) : '', (it.prompts || []).map(p => p.text).join(' '), tagHay(it), it.machine ? it.machine + ' poste:' + it.machine + ' machine:' + it.machine : ''].join(' ')) }));
}

// ── Tags de l'étiqueteur ──
// Puces par axe sous la ligne ; clic = filtre « axe:valeur » ajouté à la recherche (« tag:valeur » cherche tous les axes).
const TAG_AXES = ['domaine', 'outil', 'fonction', 'origine', 'hd'];
const ORIGINE_FR = { 'lanceur-diag':T('lanceur · diagnostic', 'launcher · diagnosis'), 'lanceur-dev':T('lanceur · dev', 'launcher · dev'), 'lanceur-relecture':T('lanceur · relecture', 'launcher · code review'), 'lanceur-recette':T('lanceur · recette', 'launcher · testing'), 'lanceur-reprise':T('lanceur · reprise', 'launcher · rework'), automate:T('automate', 'automation'), interactive:T('interactive', 'interactive') };
const tagSlug = v => norm(v).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const tagToken = t => t.axis + ':' + tagSlug(t.v);
const isTagToken = s => /^(domaine|outil|fonction|origine|hd|tag):/i.test(s);
const tagHay = it => (it.tags || []).map(t => tagToken(t) + ' tag:' + tagSlug(t.v)).join(' ');
// Un filtre de tag vaut la valeur EXACTE (« fonction:lanceur » ne prend pas « fonction:lanceur-priorite ») ; undefined :
// ce n'est pas un filtre de tag, la recherche texte s'applique.
// Filtre d'état posé par un clic sur une tuile de la vue d'ensemble (« etat:waiting », « state:waiting » en anglais) :
// il ne filtre que la liste et ne part jamais au serveur (voir scheduleFind).
const STATE_TOKEN = /^(etat|state):([a-z]+)$/;
const isStateToken = s => STATE_TOKEN.test(norm(s));
const stateToken = st => T('etat:', 'state:') + st;
const tagMatch = (it, t) => isStateToken(t) ? it.state === norm(t).match(STATE_TOKEN)[2] : isTagToken(t) ? (' ' + tagHay(it) + ' ').includes(' ' + norm(t) + ' ') : undefined;
function tagChips(it, cls) {
  // L'origine « interactive » (la majorité) et les HD (déjà dans le titre) ne prennent pas de place dans la liste.
  const ts = (it.tags || []).filter(t => TAG_AXES.includes(t.axis) && (cls === 'dtags' || (t.axis !== 'hd' && !(t.axis === 'origine' && t.v === 'interactive'))))
    .sort((a, b) => TAG_AXES.indexOf(a.axis) - TAG_AXES.indexOf(b.axis));
  // Détail : on corrige à la main (lot 3) — × retire un tag, « + tag » en ajoute un ; le manuel gagne sur l'étiqueteur.
  const edit = cls === 'dtags' && canWrite && it.sessionId;
  if (!ts.length && !edit) return null;
  const box = el('span', cls);
  for (const t of ts) {
    const c = el('span', 'chip ' + t.axis + (t.src === 'manuel' ? ' man' : ''), t.axis === 'origine' ? ORIGINE_FR[t.v] || t.v : t.v);
    c.title = T(t.axis + ' : ' + t.v + (t.src ? '  (source : ' + t.src + ')' : '') + '\nclic : filtrer la liste sur « ' + tagToken(t) + ' »', t.axis + ': ' + t.v + (t.src ? '  (source: ' + t.src + ')' : '') + '\nclick: filter the list on "' + tagToken(t) + '"');
    c.onclick = e => { e.stopPropagation(); filterTag(t); };
    c.ondblclick = e => e.stopPropagation();
    if (edit && TAG_EDITABLE.includes(t.axis)) {
      const x = el('span', 'x', '×'); x.title = T('Retirer ce tag (gardé retiré même si l’étiqueteur le repropose)', 'Remove this tag (stays removed even if the tagger suggests it again)');
      x.onclick = e => { e.stopPropagation(); postTag(it, t.axis, t.v, false); };
      c.append(x);
    }
    box.append(c);
  }
  if (edit) {
    const add = el('span', 'chip add', '+ tag'); add.title = T('Ajouter un domaine, un outil ou une fonctionnalité', 'Add a domain, a tool or a feature');
    add.onclick = e => { e.stopPropagation(); openTagEdit(it, add); };
    box.append(add);
  }
  return box;
}

// ── Correction à la main (lot 3) : POST /api/tags {id, axis, v, on} ; listes fermées par /api/tag-vocab ──
const TAG_EDITABLE = ['domaine', 'outil', 'fonction'];
let tagVocab = null;
async function loadTagVocab() {
  if (!tagVocab) { try { tagVocab = await (await fetch('/api/tag-vocab', { cache:'no-store' })).json(); } catch { return { domaines:[], outils:[] }; } }
  return tagVocab;
}
async function postTag(it, axis, v, on) {
  if (!canWrite) return;
  try {
    const r = await fetch('/api/tags', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ id: it.sessionId, axis, v, on }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { say(j.error || T('correction refusée', 'change refused')); return false; }
    say((on ? T('tag ajouté : ', 'tag added: ') : T('tag retiré : ', 'tag removed: ')) + axis + ' ' + v); tick(); return true;
  } catch { say(T('correction impossible', 'could not change the tag')); return false; }
}
/** Fenêtre flottante attachée au document (l'en-tête du détail est redessiné toutes les 2 s : elle doit lui survivre). */
async function openTagEdit(it, anchor) {
  document.querySelector('.tagpop')?.remove();
  const vocab = await loadTagVocab();
  const fonctions = (() => {             // fonctionnalités déjà portées par des sessions, les plus fréquentes d'abord
    const n = new Map(); for (const x of allItems()) for (const t of x.tags || []) if (t.axis === 'fonction') n.set(t.v, (n.get(t.v) || 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
  })();
  const pop = el('div', 'tagpop'); const r = anchor.getBoundingClientRect();
  pop.style.left = '8px'; pop.style.top = (r.bottom + 6) + 'px';
  const ax = el('select'); for (const a of TAG_EDITABLE) { const o = el('option', null, a); o.value = a; ax.append(o); }
  const inp = el('input'); inp.type = 'text'; inp.autocomplete = 'off'; inp.spellcheck = false; inp.setAttribute('list', 'tagopts');
  const dl = el('datalist'); dl.id = 'tagopts';
  const fill = () => {
    dl.replaceChildren(); const list = ax.value === 'domaine' ? vocab.domaines : ax.value === 'outil' ? vocab.outils : fonctions;
    for (const v of list) { const o = el('option'); o.value = v; dl.append(o); }
    inp.placeholder = ax.value === 'fonction' ? T('ex. power-dial (minuscules, mots reliés par -)', 'e.g. power-dial (lowercase, words joined by -)') : T('choisir dans la liste', 'pick from the list');
  };
  ax.onchange = () => { fill(); inp.value = ''; inp.focus(); };
  const ok = el('button', 'primary', T('Ajouter', 'Add')), ko = el('button', null, T('Annuler', 'Cancel'));
  const close = () => { pop.remove(); document.removeEventListener('mousedown', outside, true); };
  const outside = e => { if (!pop.contains(e.target)) close(); };
  const submit = async () => {
    const v = inp.value.trim(); if (!v) return;
    const closed = ax.value === 'domaine' ? vocab.domaines : ax.value === 'outil' ? vocab.outils : null;
    if (closed && !closed.includes(v)) { say(T(ax.value + ' hors liste : ' + v, ax.value + ' not in the list: ' + v)); return; }
    if (await postTag(it, ax.value, v, true)) close();
  };
  ok.onclick = submit; ko.onclick = close;
  inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } else if (e.key === 'Escape') close(); e.stopPropagation(); };
  // Les touches tapées dans la fenêtre (y compris sur ses boutons) ne déclenchent pas les raccourcis de la page (t, f, /…).
  pop.onkeydown = e => { if (e.key === 'Escape') close(); e.stopPropagation(); };
  pop.append(ax, inp, dl, ok, ko); document.body.append(pop);
  // Placée sous « + tag », sans déborder de l'écran (largeur connue une fois affichée).
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
  document.addEventListener('mousedown', outside, true);
  fill(); inp.focus();
}
// Validations métier (teams-watcher.ts, lot 5) : ce que le métier a tranché, qualifié par la session, avec sa
// preuve. Pures et autonomes. Une validation métier n'est jamais un go.
const VAL_FR = { valide:T('validé', 'approved'), 'valide-reserve':T('validé sous réserve', 'approved with reservations'), refuse:T('refusé', 'refused'), 'a-preciser':T('à préciser', 'to clarify') };
const VAL_CH = { teams:'Teams', mail:'email', inbound:T('demande Teams', 'Teams request'), relayed:T('rapportée, sans écrit', 'reported, not in writing') };
function validationBadge(v) {
  if (!v || !v.total) return null;
  const ok = v.settled - v.refused, pl = (n, one, many) => n + ' ' + (n > 1 ? many : one);
  const parts = [ok ? pl(ok, T('validée', 'approved'), T('validées', 'approved')) : null, v.refused ? v.refused + T(' refus', ' refused') : null, v.pending ? v.pending + T(' à préciser', ' to clarify') : null,
    v.expected ? '⏳ ' + pl(v.expected, T('attendue', 'expected'), T('attendues', 'expected')) : null, v.unqualified ? '⚠️ ' + pl(v.unqualified, T('réponse non qualifiée', 'unqualified reply'), T('réponses non qualifiées', 'unqualified replies')) : null,
    v.unanswered ? pl(v.unanswered, T('sans réponse', 'unanswered'), T('sans réponse', 'unanswered')) : null].filter(Boolean);
  return (ok || v.refused || v.pending ? '✅ ' : '') + (parts.join(' · ') || pl(v.total, 'question', 'questions'));
}
// Âge court (comme teamsWaitLine) : « 40 min », « 3 h », « 2 j ».
const valAge = ms => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? m + ' min' : m < 2880 ? Math.floor(m / 60) + ' h' : Math.floor(m / 1440) + T(' j', ' d'); };
function validationLine(i, now) {
  const at = new Date(i.at).toLocaleString(LOCALE, { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const since = i.expectedAt ? T(' depuis ', ' for ') + valAge((now || Date.now()) - i.expectedAt) : '';
  if (!i.withdrawn && (i.state === 'attendue' || i.state === 'non-qualifiee' || i.state === 'sans-reponse'))
    return i.q + ' · ' + (i.state === 'attendue' ? T('⏳ attendue de ', '⏳ expected from ') + (i.to || '?') + since
      : i.state === 'non-qualifiee' ? T('⚠️ ' + (i.to || '?') + ' a répondu, la session n’a rien enregistré', '⚠️ ' + (i.to || '?') + ' replied, the session recorded nothing')
      : T('sans réponse de ' + (i.to || '?') + ' (attente expirée)', 'no reply from ' + (i.to || '?') + ' (wait expired)'));
  return i.q + ' · ' + (i.withdrawn ? T('retirée', 'withdrawn') : VAL_FR[i.decision] || i.decision) + ' · ' + (i.validator || '?') + ' · ' + at + ' (' + (VAL_CH[i.channel] || i.channel) + ')'
    + (i.changes ? T(' · modifiée ' + i.changes + ' fois', ' · changed ' + i.changes + (i.changes > 1 ? ' times' : ' time')) : '')
    // Recopie sur le ticket (lot 7) : rien tant que le module est éteint.
    + (!i.exported || i.withdrawn ? '' : i.exported === 'ok' ? T(' · 📌 recopiée sur le ticket', ' · 📌 copied to the ticket') : i.exported === 'echec' ? T(' · ⚠️ recopie en échec', ' · ⚠️ copy to the ticket failed')
      : i.exported === 'attente' ? T(' · recopie à réessayer', ' · copy to retry') : T(' · non recopiée (' + i.exported.slice(5) + ')', ' · not copied (' + i.exported.slice(5) + ')'));
}
const validationsOf = it => (data && data.teams && data.teams.validations && it.sessionId && data.teams.validations[it.sessionId]) || null;

// Réponses Teams attendues (teams-watcher.ts, le cadrage) : une ligne par
// attente. Pure et autonome (testée seule par sessions-dashboard-tests.ps1).
function teamsWaitLine(w, now, remindersOn) {
  const d = ms => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? m + ' min' : m < 2880 ? Math.floor(m / 60) + ' h' : Math.floor(m / 1440) + T(' j', ' d'); };
  const day = t => new Date(t).toLocaleDateString(LOCALE, { timeZone: 'Europe/Paris' });
  const at = t => (day(t) === day(now) ? '' : new Date(t).toLocaleDateString(LOCALE, { timeZone: 'Europe/Paris', weekday: 'short' }) + ' ')
    + new Date(t).toLocaleTimeString(LOCALE, { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
  const who = w.chatLabel || T('le chat Teams', 'the Teams chat');
  if (w.status === 'replied') return T('💬 ' + (w.replyFrom || who) + ' a répondu il y a ' + d(now - (w.repliedAt ?? now)), '💬 ' + (w.replyFrom || who) + ' replied ' + d(now - (w.repliedAt ?? now)) + ' ago') + (w.lastError ? T(' · pas encore transmise (' + w.lastError + ')', ' · not passed on yet (' + w.lastError + ')') : T(' · transmission en cours', ' · passing it on'));
  let s = T('⏳ attend ' + who + ' depuis ' + d(now - (w.firstSentAt ?? w.sentAt)), '⏳ waiting for ' + who + ' for ' + d(now - (w.firstSentAt ?? w.sentAt)));
  if (w.reminders) s += ' · ' + w.reminders + (w.reminders > 1 ? T(' relances faites', ' reminders sent') : T(' relance faite', ' reminder sent'));
  if (w.alertedAt) return T('🔔 ' + who + ' n’a pas répondu depuis ' + d(now - (w.firstSentAt ?? w.sentAt)) + (w.reminders ? ' malgré ' + w.reminders + (w.reminders > 1 ? ' relances' : ' relance') : ''), '🔔 ' + who + ' has not replied for ' + d(now - (w.firstSentAt ?? w.sentAt)) + (w.reminders ? ' despite ' + w.reminders + (w.reminders > 1 ? ' reminders' : ' reminder') : ''));
  if (w.next && w.next.kind === 'remind' && remindersOn) s += T(' · relance à ', ' · reminder at ') + at(w.next.at);
  else if (w.next && w.next.kind === 'alert') s += T(' · alerte à ', ' · alert at ') + at(w.next.at);
  if (w.lastError) s += ' (' + w.lastError + ')';
  return s;
}
// Boutons d'une attente (lot 2) : la règle est dans teams-watcher.ts, le serveur l'appelle.
async function teamsWaitAction(it, w, action) {
  if (!canWrite) return;
  try {
    const r = await fetch('/api/teams-wait', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ sessionId: it.sessionId, messageId: w.messageId, action }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) { say(j.error || T('action refusée', 'action refused')); return; }
    say(action === 'dismiss' ? T('attente fermée', 'wait closed') : action === 'remind' ? T('relance demandée : la session va écrire dans le chat', 'reminder requested: the session will write in the chat') : T('relance repoussée au prochain jour ouvré, 10 h', 'reminder postponed to the next working day, 10:00')); tick();
  } catch { say(T('action impossible', 'action failed')); }
}
// Rangée dans « ⏳ Attente Teams » : session terminée-à-relire, inactive ou fermée qui a au moins une attente OUVERTE
// (pas encore de réponse). Une réponse arrivée (replied), une session au travail, bloquée ou qui attend ta décision
// restent dans leur groupe : il y a quelque chose à voir. Pure (testée par sessions-dashboard-tests.ps1).
function teamsHeld(state, waits) {
  return ['done', 'idle', 'closed'].includes(state) && (waits || []).some(w => w.status === 'open');
}
const teamsWaitsOf = it => (data && data.teams && data.teams.sessions && it.sessionId && data.teams.sessions[it.sessionId]) || [];
// Demande Teams ENTRANTE (lot 3) : la session a été ouverte par le veilleur pour un message reçu en direct. Elle
// propose une réponse ; l'envoi au collègue est un geste de l'utilisateur, en deux clics (le rendu repart toutes les 2 s :
// l'armement vit ici, pas dans le bouton).
const teamsInboundOf = it => (data && data.teams && data.teams.inbound && it.sessionId && data.teams.inbound[it.sessionId]) || null;
let inboundArmed = { id: null, at: 0 };
const inboundIsArmed = it => inboundArmed.id === it.sessionId && Date.now() - inboundArmed.at < 6000;
function teamsInboundOrder(inb) {
  return 'Envoie ta réponse proposée telle quelle à ' + (inb.chatLabel || inb.from) + ' dans le chat Teams (chatId ' + inb.chatId + '), avec le pied de suivi habituel.';
}
async function teamsInboundSend(it, inb) {
  if (!canWrite) return;
  if (!inboundIsArmed(it)) { inboundArmed = { id: it.sessionId, at: Date.now() }; renderDetail(); return; }
  inboundArmed = { id: null, at: 0 };
  try {
    const r = await (await fetch('/api/send?pid=' + it.pid, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ text: teamsInboundOrder(inb) }) })).json();
    say(r.error ? r.error : T('la session envoie la réponse à ' + (inb.chatLabel || inb.from), 'the session is sending the reply to ' + (inb.chatLabel || inb.from))); tick();
  } catch { say(T('envoi impossible', 'could not send')); }
}
// Clic sur une tuile : la liste ne montre plus que cet état (groupes dépliés) ; 2e clic sur la même tuile : retiré.
function filterState(st) {
  const q = $('q'), tok = stateToken(st), cur = q.value.trim().split(/\s+/).filter(Boolean), had = cur.some(x => norm(x) === norm(tok));
  q.value = cur.filter(x => !isStateToken(x)).concat(had ? [] : [tok]).join(' ');
  setPane(false); renderList(); scheduleFind(); renderOverview();
}
const activeState = () => { const t = $('q').value.trim().split(/\s+/).find(isStateToken); return t ? norm(t).match(STATE_TOKEN)[2] : null; };
function filterTag(t) {
  const q = $('q'), tok = tagToken(t), cur = q.value.trim().split(/\s+/).filter(Boolean);
  q.value = (cur.includes(tok) ? cur.filter(x => x !== tok) : cur.concat(tok)).join(' ');   // 2e clic : retire le filtre
  renderList(); scheduleFind();
}
const byKey = key => allItems().find(it => it.key === key);

// ── Changements (git) d'une session ouverte : worktree (déduit de ses commandes), fichiers non commités, commits
// non poussés, retard sur master. « Peut se fermer » : inactive, rien à commiter ni à pousser, et PR mergée — ou
// branche poussée déjà intégrée à master.
// Sans worktree (jamais créé, ou déjà purgé), la session travaillait dans la copie principale, partagée : son
// désordre n'est pas le sien — seule la PR compte.
// ── Tâches PROGRAMMÉES par la session elle-même (CronCreate, réveil d'une boucle /loop) : le serveur rejoue son
// transcript (scheduled.ts). Sauf « durable », elles vivent dans le process : fermer ou relancer la session les annule.
const schedOf = it => (it && Array.isArray(it.scheduled) ? it.scheduled : []);
const schedFragile = it => schedOf(it).filter(j => !j.durable);
function schedWhen(j, now) {
  if (!j.at) return T('heure inconnue', 'unknown time');
  const d = new Date(j.at), hm = d.toLocaleTimeString(LOCALE, { hour:'2-digit', minute:'2-digit' });
  const day = d.toDateString() === new Date(now).toDateString() ? '' : d.toDateString() === new Date(now + 86400000).toDateString() ? T('demain ', 'tomorrow ')
    : d.toLocaleDateString(LOCALE, { weekday:'short', day:'numeric', month:'short' }) + ' ';
  return day + T('à ', 'at ') + hm + (j.at > now ? T(' (dans ' + ago(j.at - now) + ')', ' (in ' + ago(j.at - now) + ')') : T(' (maintenant)', ' (now)'));
}
function schedLine(j, now) {
  const what = j.kind === 'wakeup' ? T('réveil programmé', 'scheduled wake-up')
    : j.recurring ? T('tâche récurrente', 'recurring task') + (j.cron ? ' « ' + j.cron + ' »' : '') + T(', prochaine', ', next') : T('tâche programmée', 'scheduled task');
  return '⏰ ' + what + ' ' + schedWhen(j, now);
}
const schedList = it => schedOf(it).map(j => schedLine(j, data.now) + (j.prompt ? '\n  « ' + j.prompt.slice(0, 240) + ' »' : '')).join('\n');
const SCHED_WARN = T('Liée à cette session : la fermer ou la relancer annule la tâche.', 'Tied to this session: closing or relaunching it cancels the task.');
const prMerged = it => !!(it.prInfo && it.prInfo.state === 'MERGED');
const closable = it => {
  const g = it.git; if (it.kind !== 'open' || it.headless || it.status !== 'idle' || !g || schedFragile(it).length) return false;
  if (!g.worktree) return prMerged(it);
  if (g.nFiles || (g.upstream && g.ahead)) return false;
  return prMerged(it) || !!(g.upstream && g.merged);
};
const plural = (n, one, many) => n + ' ' + (n > 1 ? many : one);
const gitOpen = new Set();          // sessions dont la liste des fichiers est dépliée (survit aux rafraîchissements)
function gitBlock(it) {
  const box = el('div', 'gitbox'), g = it.git;
  const line = el('div', 'gl');
  const refresh = el('a', null, T('actualiser', 'refresh')); refresh.href = '#';
  refresh.onclick = async e => { e.preventDefault(); try { await post('/api/git-refresh?pid=' + it.pid); say(T('lecture de l\'état git…', 'reading git status…')); } catch { say(T('échec de la demande', 'request failed')); } };
  if (!g) { line.append(el('span', null, T('Changements : ' + (it.gitDir ? 'pas encore lus (' + short(it.gitDir) + ')' : 'dossier inconnu') + ' · ', 'Changes: ' + (it.gitDir ? 'not read yet (' + short(it.gitDir) + ')' : 'unknown folder') + ' · ')), refresh); box.append(line); return box; }
  if (!g.worktree) {
    line.append(el('span', 'gw', T('pas de worktree', 'no worktree')), T(' · aucun worktree existant dans ses dernières commandes (jamais créé, ou déjà purgé) : elle travaille dans la copie principale, partagée — ses changements n\'y sont pas isolables', ' · no existing worktree in its recent commands (never created, or already removed): it works in the main, shared checkout — its changes cannot be isolated there'));
    if (closable(it)) { const t = el('span', 'tag merged', T('✓ peut se fermer', '✓ can be closed')); t.title = T('Inactive et PR mergée', 'Idle and PR merged'); line.append(t); }
    box.append(line); return box;
  }
  const w = el('span', 'gw', 'worktree ' + g.top.split('\\').pop()); w.title = g.top + T('\nDéduit des dernières commandes de la session', '\nInferred from the session\'s recent commands'); line.append(w);
  line.append(' · ' + (g.branch && g.branch !== '(detached)' ? T('branche ', 'branch ') + g.branch : T('HEAD détaché', 'detached HEAD')));
  if (closable(it)) { const t = el('span', 'tag merged', T('✓ peut se fermer', '✓ can be closed')); t.title = T('Inactive, rien à commiter ni à pousser, ' + (prMerged(it) ? 'PR mergée' : 'branche intégrée à ' + g.base), 'Idle, nothing to commit or push, ' + (prMerged(it) ? 'PR merged' : 'branch merged into ' + g.base)); line.append(t); }
  line.append(el('span', 'tag ' + (g.nFiles ? 'ko' : 'ok'), g.nFiles ? plural(g.nFiles, T('fichier non commité', 'uncommitted file'), T('fichiers non commités', 'uncommitted files')) : T('rien à commiter', 'nothing to commit')));
  if (g.upstream) { if (g.ahead) line.append(el('span', 'tag pending', plural(g.ahead, T('commit non poussé', 'unpushed commit'), T('commits non poussés', 'unpushed commits')))); else line.append(el('span', 'tag ok', T('tout est poussé', 'everything pushed'))); }
  else if (g.branch && g.branch !== '(detached)') line.append(el('span', 'tag pending', T('branche jamais poussée', 'branch never pushed')));
  if (g.behind) line.append(el('span', 'tag pending', plural(g.behind, T('commit distant à récupérer', 'remote commit to pull'), T('commits distants à récupérer', 'remote commits to pull'))));
  if (g.base && g.baseBehind) { const t = el('span', 'tag draft', T(g.baseBehind + ' de retard sur ' + g.base.replace('origin/', ''), g.baseBehind + ' behind ' + g.base.replace('origin/', ''))); t.title = T(g.baseAhead + ' commit(s) de la branche absents de ' + g.base, g.baseAhead + ' branch commit(s) not in ' + g.base); line.append(t); }
  box.append(line);
  const l2 = el('div', 'gl');
  if (g.last) l2.append(T('dernier commit ' + g.last.h + ' « ' + g.last.s + ' » · il y a ' + ago(data.now - g.last.at) + ' · ', 'last commit ' + g.last.h + ' "' + g.last.s + '" · ' + ago(data.now - g.last.at) + ' ago · '));
  l2.append(T('lu il y a ' + ago(data.now - g.at) + ' · ', 'read ' + ago(data.now - g.at) + ' ago · '), refresh);
  box.append(l2);
  if (g.nFiles) {
    const d = el('details'); d.open = gitOpen.has(it.key); d.ontoggle = () => d.open ? gitOpen.add(it.key) : gitOpen.delete(it.key);
    d.append(el('summary', null, g.nFiles > g.files.length ? T(g.files.length + ' premiers fichiers sur ' + g.nFiles, 'first ' + g.files.length + ' files of ' + g.nFiles) : T('fichiers', 'files')));
    const ul = el('div', 'gfiles'); for (const f of g.files) { const r = el('div'); r.append(el('span', 'gk', GIT_KIND_EN[f.k] && LANG === 'en' ? GIT_KIND_EN[f.k] : f.k), f.p); ul.append(r); } d.append(ul); box.append(d);
  }
  return box;
}

// ── Ménage : fermer d'un coup les sessions qui peuvent se fermer (le serveur revérifie la règle) ──
const closePick = new Map();        // clé -> coché ? (absent = coché)
let closingMany = false;
async function closeMany(list, rule) {
  if (closingMany) return; if (!list.length) return say(T('aucune session cochée', 'no session checked'));
  if (!confirm(T('Fermer ' + plural(list.length, 'session', 'sessions') + ' ?\n\n' + list.map(it => '• ' + label(it)).join('\n') + '\n\nChacune reçoit /exit (arrêtée si elle ne sort pas en 10 s). Les conversations restent reprenables depuis « Fermées » ; les worktrees ne sont pas touchés.', 'Close ' + plural(list.length, 'session', 'sessions') + '?\n\n' + list.map(it => '• ' + label(it)).join('\n') + '\n\nEach one gets /exit (stopped if it does not exit within 10 s). The conversations stay reopenable from "Closed"; worktrees are not touched.'))) return;
  closingMany = true; say(T('fermeture de ' + plural(list.length, 'session', 'sessions') + '…', 'closing ' + plural(list.length, 'session', 'sessions') + '…'));
  try {
    const r = await (await fetch('/api/close-many', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ pids: list.map(it => it.pid), rule: rule || 'closable' }) })).json();
    const forced = r.closed.filter(c => c.forced).length;
    say(plural(r.closed.length, T('session fermée', 'session closed'), T('sessions fermées', 'sessions closed')) + (forced ? T(' (dont ' + forced + ' arrêtée(s) faute de réponse à /exit)', ' (' + forced + ' stopped, no answer to /exit)') : '') + (r.skipped.length ? T(' · ' + r.skipped.length + ' sautée(s)', ' · ' + r.skipped.length + ' skipped') : ''));
    if (r.skipped.length) alertSkipped(r.skipped);
  } catch { say(T('échec de la demande', 'request failed')); }
  closingMany = false; tick(); loadClosed();
}
// ── Relance groupée : fermer puis reprendre (--resume) les sessions « À traiter », « ⏳ Attente Teams » et « Inactives ».
// Le process redémarre pour de bon : compte changé, serveurs MCP à réinitialiser. Seule une session INACTIVE peut
// recevoir /exit : celle qui est bloquée sur un dialogue ou qui attend une commande en arrière-plan est annoncée, pas
// touchée. Les sessions au travail, les automates et les sessions fermées ne sont pas concernés. Pure.
function restartPlan(items) {
  const go = [], skip = [];
  for (const it of items) {
    if (it.kind !== 'open' || it.headless || !['waiting', 'ask', 'done', 'teams', 'idle'].includes(it.state)) continue;
    if (it.status === 'idle') go.push(it);
    else skip.push({ it, why: it.status === 'waiting' ? T('bloquée sur une question', 'waiting on a question') : it.status === 'shell' ? T('commande en arrière-plan en cours', 'background command running') : T('statut ', 'status ') + it.status });
  }
  return { go, skip };
}
const RESTART_GROUPS = [[T('À traiter', 'To handle'), ['waiting', 'ask', 'done']], [T('⏳ Attente Teams', '⏳ Waiting on Teams'), ['teams']], [T('Inactives', 'Idle'), ['idle']]];
const restartCounts = list => RESTART_GROUPS.map(([t, st]) => [t, list.filter(it => st.includes(it.state)).length]).filter(x => x[1]).map(x => x[0] + ' ' + x[1]).join(' · ');
const restartSig = () => { const p = restartPlan(allItems()); return (canWrite ? 'w' : 'r') + (restartingMany ? '!' : '') + p.go.map(it => it.key + it.state).join(',') + '|' + p.skip.map(s => s.it.key).join(','); };
let restartingMany = false;
async function restartMany() {
  if (restartingMany || !canWrite) return;
  const { go, skip } = restartPlan(allItems());
  if (!go.length) return say(T('aucune session à relancer', 'no session to restart'));
  if (!confirm(T('Relancer ' + plural(go.length, 'session', 'sessions') + ' ?\n\n', 'Restart ' + plural(go.length, 'session', 'sessions') + '?\n\n') + restartCounts(go)
    + T('\n\nChacune reçoit /exit puis reprend sa conversation (--resume), dans son onglet quand c’est possible, sinon dans un nouvel onglet. Le process redémarre : nouveau compte pris en compte, serveurs MCP réinitialisés. Une session dont l’invite porte un brouillon est laissée telle quelle.', '\n\nEach one gets /exit then resumes its conversation (--resume), in its own tab when possible, otherwise in a new tab. The process restarts: new account taken into account, MCP servers reset. A session with a draft in its prompt is left as it is.')
    + (skip.length ? T('\n\nNon relancée' + (skip.length > 1 ? 's' : '') + ' :\n', '\n\nNot restarted:\n') + skip.map(s => '• ' + label(s.it) + ' — ' + s.why).join('\n') : '')
    + T('\n\nDurée : environ ' + Math.round(20 + go.length * 1.5) + ' s.', '\n\nDuration: about ' + Math.round(20 + go.length * 1.5) + ' s.'))) return;
  restartingMany = true; say(T('relance de ' + plural(go.length, 'session', 'sessions') + '…', 'restarting ' + plural(go.length, 'session', 'sessions') + '…')); renderDetail(true);
  try {
    const r = await (await fetch('/api/relaunch-many', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ pids: go.map(it => it.pid) }) })).json();
    const tabs = r.relaunched.filter(x => !x.sameTab).length;
    say(plural(r.relaunched.length, T('session relancée', 'session restarted'), T('sessions relancées', 'sessions restarted')) + (tabs ? T(' (dont ' + tabs + ' dans un nouvel onglet)', ' (' + tabs + ' in a new tab)') : '') + (r.skipped.length ? T(' · ' + r.skipped.length + ' sautée(s)', ' · ' + r.skipped.length + ' skipped') : ''));
    if (r.skipped.length) alertSkipped(r.skipped);
  } catch { say(T('échec de la demande', 'request failed')); }
  restartingMany = false; tick(); loadClosed();
}
function restartPanel() {
  if (!canWrite) return null;
  const { go, skip } = restartPlan(allItems()); if (!go.length && !skip.length) return null;
  const wrap = el('div');
  wrap.append(el('h2', null, T('Relancer les sessions — ', 'Restart sessions — ') + go.length));
  const act = el('div', 'actions');
  const b = el('button', 'primary', restartingMany ? T('Relance en cours…', 'Restarting…') : T('Relancer les ' + plural(go.length, 'session', 'sessions') + '…', 'Restart ' + plural(go.length, 'session', 'sessions') + '…')); b.disabled = restartingMany || !go.length;
  b.title = T('Ferme (/exit) puis reprend (--resume) les sessions « À traiter », « ⏳ Attente Teams » et « Inactives » : à faire après un changement de compte, ou pour réinitialiser les serveurs MCP. Les sessions au travail ne sont pas touchées.', 'Closes (/exit) then resumes (--resume) the "To handle", "⏳ Waiting on Teams" and "Idle" sessions: do it after an account change, or to reset the MCP servers. Working sessions are not touched.');
  b.onclick = restartMany; act.append(b); wrap.append(act);
  wrap.append(el('div', 'empty', (restartCounts(go) || T('aucune session inactive', 'no idle session')) + (skip.length ? T(' — ' + skip.length + ' laissée' + (skip.length > 1 ? 's' : ''), ' — ' + skip.length + ' left alone') + ' (' + skip.map(s => label(s.it) + T(' : ', ': ') + s.why).join(' ; ').slice(0, 240) + ')' : '')));
  return wrap;
}
// ── Ménage large : fermer d'un coup les sessions INACTIVES, même avec du travail en cours (la conversation reste
// reprenable, le worktree n'est pas touché). Cochées par défaut : inactives depuis au moins le seuil choisi. Le
// serveur revérifie seulement « inactive » (et une invite vide) au moment de fermer. ──
const IDLE_STEPS = [[1, '≥ 1 h'], [4, '≥ 4 h'], [24, '≥ 24 h'], [0, T('toutes', 'all')]];
let idleMinH = 4; try { const v = +localStorage.getItem('sd.idleMinH'); if (IDLE_STEPS.some(s => s[0] === v)) idleMinH = v; } catch {}
const idlePick = new Map();         // clé -> coché à la main (absent = selon le seuil)
const idleList = () => allItems().filter(it => it.kind === 'open' && !it.headless && it.status === 'idle').sort((a, b) => a.since - b.since);
const idleH = it => (data.now - it.since) / 3600000;
const idleChecked = it => idlePick.has(it.key) ? idlePick.get(it.key) : idleH(it) >= idleMinH;
const idleSig = () => idleMinH + ':' + idleList().map(it => it.key + (idlePick.has(it.key) ? (idlePick.get(it.key) ? '+' : '-') : '')).join(',');
function idleRisk(it) {
  const g = it.git, r = [];
  if (g && g.worktree) {
    if (g.nFiles) r.push(plural(g.nFiles, T('fichier non commité', 'uncommitted file'), T('fichiers non commités', 'uncommitted files')));
    if (g.upstream && g.ahead) r.push(plural(g.ahead, T('commit non poussé', 'unpushed commit'), T('commits non poussés', 'unpushed commits')));
    else if (!g.upstream && g.branch && g.branch !== '(detached)') r.push(T('branche jamais poussée', 'branch never pushed'));
  }
  if (it.prInfo && it.prInfo.state === 'OPEN') r.push(T('PR #' + it.pr + ' ouverte', 'PR #' + it.pr + ' open'));
  return r;
}
function idlePanel() {
  const list = idleList(); if (!list.length) return null;
  const wrap = el('div');
  const picked = list.filter(idleChecked);
  wrap.append(el('h2', null, T('Inactives — ' + list.length + ' · ' + picked.length + ' cochée' + (picked.length > 1 ? 's' : ''), 'Idle — ' + list.length + ' · ' + picked.length + ' checked')));
  const act = el('div', 'actions');
  for (const [h, lbl] of IDLE_STEPS) {
    const b = el('button', h === idleMinH ? 'primary' : null, lbl); b.title = h ? T('Cocher les sessions inactives depuis au moins ' + h + ' h', 'Check the sessions idle for at least ' + h + ' h') : T('Cocher toutes les sessions inactives', 'Check all idle sessions');
    b.onclick = () => { idleMinH = h; idlePick.clear(); try { localStorage.setItem('sd.idleMinH', String(h)); } catch {} renderDetail(true); };
    act.append(b);
  }
  const bc = el('button', 'primary', T('Fermer la sélection (' + picked.length + ')…', 'Close selection (' + picked.length + ')…'));
  bc.title = T('Ferme les sessions cochées (/exit, arrêt si elles ne sortent pas en 10 s) ; elles restent reprenables depuis « Fermées » ; les worktrees ne sont pas touchés', 'Closes the checked sessions (/exit, stopped if they do not exit within 10 s); they stay reopenable from "Closed"; worktrees are not touched');
  bc.onclick = () => closeMany(idleList().filter(idleChecked), 'idle');
  const bn = el('button', null, T('Décocher tout', 'Uncheck all')); bn.onclick = () => { list.forEach(it => idlePick.set(it.key, false)); renderDetail(true); };
  act.append(bc, bn); wrap.append(act);
  const box = el('div', 'notifs');
  for (const it of list) {
    const d = el('div', 'notif done pick');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = idleChecked(it); cb.onclick = e => e.stopPropagation();
    cb.onchange = () => { idlePick.set(it.key, cb.checked); renderDetail(true); };
    const risk = idleRisk(it);
    const nx = el('span', 'nx', (risk.length ? '⚠ ' + risk.join(' · ') : (closable(it) ? T('✓ peut se fermer', '✓ can be closed') : T('rien en cours d’isolable', 'no isolated work in progress'))));
    d.append(cb, el('span', 'when', T('inactive ', 'idle ') + ago(data.now - it.since)), el('span', 'nt', label(it)), nx);
    d.title = T('Sélectionner la session', 'Select the session'); d.onclick = () => select(it.key, true); box.append(d);
  }
  wrap.append(box);
  return wrap;
}
function alertSkipped(sk) { console.log('[sessions] fermeture sautée :', sk); notice = null; setTimeout(() => say(sk.map(s => s.title + T(' : ', ': ') + s.why).join(' · ').slice(0, 300)), 5200); }

// ── Tableau par projet (▦) : une carte par PR (ou ticket HD, ou session), rangée dans la colonne la plus avancée
// de ses sessions. Livré = PR mergée ; à merger = PR ouverte prête ; en recette = un dev-deploy / env de branche
// lancé par la session ; en cours = brouillon, branche ou worktree ; à cadrer = rien de tout ça. ──
const STAGES = [['cadrer', T('À cadrer', 'To scope')], ['cours', T('En cours', 'In progress')], ['recette', T('En recette', 'In review')], ['merger', T('À merger', 'To merge')], ['livre', T('Livré · 7 j', 'Shipped · 7 d')]];
// Le titre (ai-title) est figé au PREMIER sujet de la session : une session qui a enchaîné plusieurs tickets garde
// « Remise parrainage… » alors qu'elle parle de HD-111111. Le serveur donne le dernier HD cité dans ses prompts
// tapés (topicHd, absent si c'est déjà celui du 1er message) : on l'affiche « → HD-… » à côté du titre quand le titre ne le cite pas déjà.
const driftHd = it => it.topicHd && !String(it.title || '').toUpperCase().includes(it.topicHd) ? it.topicHd : null;
const driftTag = it => { const h = driftHd(it); if (!h) return null; const t = el('span', 'tag drift', '→ ' + h); t.title = T('Dernier ticket cité dans cette session : le titre décrit son premier sujet', 'Last ticket mentioned in this session: the title describes its first topic'); return t; };
const hdOf = it => { const m = [it.title, it.name, ...(it.prompts || []).map(p => p.text)].join(' ').match(/HD-\d{6}/i); return m ? m[0].toUpperCase() : null; };
function stageOf(it) {
  const p = it.pr && it.prInfo ? it.prInfo : null;
  if (p && p.state === 'MERGED') return 'livre';
  if (p && p.state === 'CLOSED') return null;               // PR fermée sans merge : abandonnée
  if (it.recette) return 'recette';
  if (p && !p.draft) return 'merger';
  if (it.pr || it.wt || (it.git && it.git.worktree)) return 'cours';
  return 'cadrer';
}
let boardMode = false;
function openBoard() { findMode = false; newMode = false; bcMode = false; launchMode = false; chatsMode = false; selected = null; sessionStorage.removeItem('cc.sel'); boardMode = true; setPane(true); renderList(); renderDetail(true); }
function closeBoard() { boardMode = false; setPane(false); renderDetail(true); }
function boardCards() {
  const week = data.now - 7 * 86400000;
  // Ouvertes (hors automates) ; fermées seulement si elles portent une PR ou une recette (sinon : vieilles conversations).
  const its = allItems().filter(it => !it.hidden && !it.headless && (it.kind === 'open' || it.pr || it.recette));
  const cards = new Map();
  for (const it of its) {
    const st = stageOf(it); if (!st) continue;
    if (st === 'livre' && it.since < week) continue;
    const hd = hdOf(it), key = it.pr ? 'pr' + it.pr : hd ? hd : it.key;
    let c = cards.get(key); if (!c) cards.set(key, c = { key, hd, pr: it.pr, prUrl: it.prUrl, items: [], stage: st });
    c.items.push(it); if (!c.hd) c.hd = hd;
    if (STAGES.findIndex(s => s[0] === st) > STAGES.findIndex(s => s[0] === c.stage)) c.stage = st;
  }
  for (const c of cards.values()) { c.items.sort((a, b) => (b.kind === 'open') - (a.kind === 'open') || b.since - a.since); c.lead = c.items[0]; c.at = Math.max(...c.items.map(i => i.since)); }
  return [...cards.values()];
}
function renderBoard(force) {
  const main = $('main'); const cards = boardCards();
  const sig = cards.map(c => c.key + ':' + c.stage + ':' + c.items.map(i => i.key + i.state).join(',')).join('|');
  if (!force && detailKey === '__board__' && main.dataset.sig === sig) return;
  detailKey = '__board__'; main.dataset.sig = sig; main.replaceChildren();
  main.append(el('div', 'dtitle', T('Tableau par projet', 'Board by project')),
              el('div', 'meta', T('Une carte par PR (à défaut par ticket HD, sinon par session), dans la colonne la plus avancée de ses sessions. Sessions fermées : seulement celles qui ont une PR ou une recette ; livré : 7 derniers jours. Clic : ouvrir la session.', 'One card per PR (otherwise per ticket, otherwise per session), in the most advanced column of its sessions. Closed sessions: only those with a PR or a review; shipped: last 7 days. Click: open the session.')));
  const board = el('div', 'board');
  for (const [k, title] of STAGES) {
    const col = el('div', 'bcol'); const list = cards.filter(c => c.stage === k).sort((a, b) => b.at - a.at);
    col.append(el('div', 'bhead', title + ' · ' + list.length));
    for (const c of list) {
      const it = c.lead, card = el('div', 'bcard ' + it.state);
      const t = el('div', 'bt'); t.append(el('span', 'dot'), ' ', label(it)); card.append(t);
      const m = el('div', 'bm');
      if (c.hd) m.append(el('span', 'tag', c.hd));
      if (c.pr) { const a = prLink(it); if (a) m.append(a); prTags(it).forEach(x => m.append(x)); }
      if (closable(it)) m.append(el('span', 'tag merged', T('✓ peut se fermer', '✓ can be closed')));
      card.append(m);
      const open = c.items.filter(i => i.kind === 'open').length;
      card.append(el('div', 'bs', (open ? plural(open, T('session ouverte', 'open session'), T('sessions ouvertes', 'open sessions')) : T('fermée', 'closed')) + (c.items.length > open && open ? T(' · ' + (c.items.length - open) + ' fermée(s)', ' · ' + (c.items.length - open) + ' closed') : '') + ' · ' + LABEL[it.state] + ' · ' + T('il y a ' + ago(data.now - c.at), ago(data.now - c.at) + ' ago')));
      card.title = c.items.map(i => '• ' + label(i) + ' — ' + LABEL[i.state]).join('\n');
      card.onclick = () => select(it.key, true);
      col.append(card);
    }
    if (!list.length) col.append(el('div', 'empty', '—'));
    board.append(col);
  }
  main.append(board);
}

// ── Conversations Teams (💬, module « teams », teams-watcher.ts lot 9) : la vue TRANSVERSE, une ligne par chat et non par
// session. Le veilleur liste tous les chats actifs (qu'une session y soit abonnée ou non) ; la page les range en « à toi
// de répondre » (dernier mot au collègue, aucune session ne l'a reçu), « à voir » (il s'y est passé quelque chose depuis
// ton dernier pointage : un collègue a écrit, ou une session a écrit en ton nom) et « à jour ». L'état lu de Teams ne
// sert pas : le veilleur marque lu ce qu'une session a traité. Lue par /api/teams-conversations, relue toutes les 30 s
// et dès que le veilleur a refait sa liste ; les compteurs du bouton viennent de l'état (data.teams.conversations).
let chatsMode = false, chatsData = null, chatsTimer = null;
const chatsOff = () => !(data && data.teams && data.teams.conversations);
function chatsBadge() {
  const c = data && data.teams && data.teams.conversations, b = $('chatsbtn'); b.hidden = !c; if (!c) return;
  const n = c.reply + c.unseen; $('chatsn').textContent = n ? String(n) : '';
  if (chatsMode && chatsData && chatsData.at !== c.at) loadChats();   // le veilleur vient de refaire sa liste
}
function openChats() { if (chatsOff()) return; findMode = false; newMode = false; bcMode = false; boardMode = false; launchMode = false; selected = null; sessionStorage.removeItem('cc.sel'); chatsMode = true; setPane(true);
  clearInterval(chatsTimer); chatsTimer = setInterval(loadChats, 30000); renderList(); renderDetail(true); loadChats(); }
function closeChats() { chatsMode = false; setPane(false); clearInterval(chatsTimer); renderDetail(true); }
async function loadChats(force) {
  if (!chatsMode) { clearInterval(chatsTimer); return; }
  // Pendant qu'on tape une réponse, la liste n'est pas redessinée sous les doigts (elle l'est à l'envoi, ou à la relecture suivante).
  try { const r = await fetch('/api/teams-conversations', { cache:'no-store' }); chatsData = r.ok ? await r.json() : null; if (chatsMode && (force === true || !chatBusy())) renderChats(); } catch { say(T('conversations illisibles', 'could not read the conversations')); }
}
// chatGroups est PURE (testée par server/test/conversations-page.test.ts) : lignes du serveur → les trois groupes de la vue.
function chatGroups(rows) {
  const g = [
    { key:'reply', title:T('À toi de répondre', 'Your turn to reply'), hint:T('le dernier mot est au collègue et aucune session ne l’a reçu', 'a colleague wrote last and no session received it'), rows:[] },
    { key:'unseen', title:T('À voir', 'To look at'), hint:T('du nouveau depuis ton dernier pointage : un collègue a écrit, ou une session a écrit en ton nom', 'something new since you last checked: a colleague wrote, or a session wrote on your behalf'), rows:[] },
    { key:'ok', title:T('À jour', 'Up to date'), hint:'', rows:[] },
  ];
  for (const r of rows || []) (r.ball === 'reply' ? g[0] : r.unseen ? g[1] : g[2]).rows.push(r);
  for (const x of g) x.rows.sort((a, b) => b.lastAt - a.lastAt);
  return g;
}
async function chatSeen(chatId, action, at) {
  if (!canWrite) return;
  try {
    const r = await (await fetch('/api/teams-seen', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ chatId, action, at }) })).json();
    if (r.error) say(T('refusé : ', 'refused: ') + r.error);
  } catch { say(T('échec de la demande', 'request failed')); }
  loadChats(true);
}
const CHAT_ICON = { oneOnOne:'👤', group:'👥', meeting:'📅' };
const CHAT_ROLE = { linked:T('suit ce fil', 'follows this thread'), wait:T('attend leur réponse', 'waiting for their reply'), replied:T('reçoit leur réponse', 'receives their reply'), inbound:T('ouverte pour cette demande', 'opened for this request'), past:T('y a écrit', 'wrote here') };
const CHAT_WHY = { mention:T('tu es mentionné', 'you are mentioned'), quote:T('on répond à un de tes messages', 'someone replies to one of your messages'), named:T('on t’y nomme', 'you are named'), question:T('question qui suit ton message', 'question after your message') };
// Lot 10 : messages en entier, fil dépliable (/api/teams-thread), réponse depuis la page (/api/teams-reply — le veilleur
// poste dans Teams en ton nom, sur ton clic). Brouillons, fils ouverts et boîtes de réponse survivent aux relectures.
const chatDrafts = new Map(), chatReplying = new Set(), chatThreads = new Map(), chatWide = new Set();
let chatSending = null;
const chatTyping = () => !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.creply'));
// Lot 11 : confier un fil à une session (/api/teams-link). La session reçoit les messages à traiter puis toute la suite,
// jusqu'au « Détacher ». Pendant le choix de la session, la liste n'est pas redessinée (comme pendant la frappe).
// « → session » sur un message : il rejoint les messages de référence de la remise (chatPickAnchors — on peut en retenir
// plusieurs, un nouveau clic sur un message retenu l'enlève) ; consigne facultative, et
// une case pour ne PAS suivre la suite du fil (remise unique).
let chatPicking = null, chatPickValue = 'new', chatPickNote = '', chatPickFollow = true;
const chatPickAnchors = new Map();   // id du message → { who, at }
function chatPickClose() { chatPicking = null; chatPickAnchors.clear(); chatPickNote = ''; }
// « Confier » (anchor absent) ouvre ou referme le choix pour ce fil ; « → session » retient ou enlève un message, sans
// toucher à la session choisie ni à la consigne déjà tapée.
function chatPick(chatId, anchor) {
  if (chatPicking !== chatId) { chatPickClose(); chatPicking = chatId; chatPickValue = 'new'; chatPickFollow = true; if (anchor) chatPickAnchors.set(anchor.id, anchor); }
  else if (!anchor) chatPickClose();
  else if (chatPickAnchors.has(anchor.id)) chatPickAnchors.delete(anchor.id);
  else chatPickAnchors.set(anchor.id, anchor);
  renderChats();
  const i = $('main').querySelector('.cpick input[type=text]'); if (i && !anchor) i.focus();
}
const chatBusy = () => chatTyping() || !!chatPicking;
// chatTargets est PURE (testée par server/test/conversations-page.test.ts) : les sessions à qui confier un fil — ouvertes,
// avec terminal, la plus récemment active d'abord.
function chatTargets(items) {
  return (items || []).filter(i => i.kind === 'open' && !i.headless && i.sessionId).sort((a, b) => (b.since || 0) - (a.since || 0));
}
async function chatLink(chatId, action, sessionId) {
  if (!canWrite) return;
  const extra = action === 'attach' ? { anchors: [...chatPickAnchors.keys()], note: chatPickNote, once: !chatPickFollow } : {};
  try {
    const r = await (await fetch('/api/teams-link', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ chatId, action, sessionId, ...extra }) })).json();
    if (r.error) say(T('refusé : ', 'refused: ') + r.error); else say(action === 'detach' ? T('fil détaché', 'thread detached') : sessionId === 'new' ? T('fil confié : une nouvelle session s’ouvre', 'thread handed over: a new session is opening') : T('fil confié : la session le reçoit dans un instant', 'thread handed over: the session gets it in a moment'));
  } catch { say(T('échec de la demande', 'request failed')); }
  chatPickClose(); loadChats(true);
}
// chatWho est PURE (testée par server/test/conversations-page.test.ts) : l'auteur d'un message tel qu'on l'affiche.
function chatWho(m) {
  return m.by === 'me' ? T('toi', 'you') : m.by === 'session' ? T('🤖 une session, en ton nom', '🤖 a session, on your behalf') : m.from || T('une application', 'an app');
}
function chatMsg(m, when, chatId, linked) {
  const picked = chatId && chatPicking === chatId && chatPickAnchors.has(m.id);
  const d = el('div', 'cmsg' + (m.by === 'me' || m.by === 'session' ? ' mine' : '') + (picked ? ' anchor' : ''));
  const h = el('span', 'who' + (m.by === 'session' ? ' ses' : ''), chatWho(m)); if (when) h.append(el('span', 'when', T(' · il y a ' + ago(data.now - m.at), ' · ' + ago(data.now - m.at) + ' ago')));
  if (chatId && m.id && canWrite && !linked) { const b = el('button', 'tos', picked ? T('✓ retenu', '✓ picked') : chatPicking === chatId && chatPickAnchors.size ? T('+ ajouter', '+ add') : '→ session'); b.title = picked ? T('Enlever ce message de ceux remis à la session', 'Remove this message from the ones handed to the session') : T('Ouvrir ou relancer une session à partir de ce message — tu peux en retenir plusieurs : ils deviennent la référence, avec ce qui les entoure', 'Open or restart a session from this message — you can pick several: they become the reference, with what surrounds them'); b.onclick = e => { e.stopPropagation(); chatPick(chatId, { id: m.id, who: chatWho(m), at: m.at }); }; h.append(b); }
  d.append(h, el('div', 'txt', m.text)); return d;
}
async function chatToggleThread(chatId) {
  if (chatThreads.has(chatId)) { chatThreads.delete(chatId); return renderChats(); }
  chatThreads.set(chatId, null); renderChats();
  try { const r = await fetch('/api/teams-thread?chatId=' + encodeURIComponent(chatId), { cache:'no-store' }); if (chatThreads.has(chatId)) chatThreads.set(chatId, r.ok ? await r.json() : { fresh:false, messages:[] }); }
  catch { chatThreads.delete(chatId); say(T('fil illisible', 'could not read the thread')); }
  if (chatsMode) renderChats();
}
async function chatSend(chatId) {
  const text = (chatDrafts.get(chatId) || '').trim(); if (!text || chatSending || !canWrite) return;
  chatSending = chatId; renderChats();
  try {
    const r = await (await fetch('/api/teams-reply', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ chatId, text }) })).json();
    if (r.error) say(T('non envoyé : ', 'not sent: ') + r.error); else { chatDrafts.delete(chatId); chatReplying.delete(chatId); chatThreads.delete(chatId); say(T('envoyé dans Teams', 'sent in Teams')); }
  } catch { say(T('échec de la demande — vérifie dans Teams avant de renvoyer', 'request failed — check in Teams before sending again')); }
  chatSending = null; await loadChats(true);
}
function renderChats() {
  const main = $('main'), keep = detailKey === '__chats__' ? main.scrollTop : 0;
  const foc = chatTyping() ? document.activeElement : null, focId = foc && foc.closest('.creply').dataset.chat, sel = foc && [foc.selectionStart, foc.selectionEnd];
  detailKey = '__chats__'; main.replaceChildren();
  const D = chatsData, rows = D && D.rows;
  main.append(el('div', 'dtitle', T('Conversations Teams', 'Teams conversations')));
  if (!D) { main.append(el('div', 'meta', T('Chargement…', 'Loading…'))); return; }
  if (!rows) { main.append(el('div', 'meta', T('Vue éteinte : le veilleur n’a encore rien listé ({ "conversations": { "enabled": true } } dans modules.teams de config.json).', 'View off: the watcher has not listed anything yet ({ "conversations": { "enabled": true } } in modules.teams of config.json).'))); return; }
  const groups = chatGroups(rows), todo = groups[0].rows.length + groups[1].rows.length;
  const canSend = canWrite && !!(data.teams && data.teams.conversations && data.teams.conversations.send);
  const meta = el('div', 'meta', T(rows.length + ' chats actifs sur 14 jours (1:1, groupes, réunions), qu’une session les suive ou non · liste d’il y a ' + ago(data.now - D.at) + ' · '
    + (todo ? todo + ' à traiter' : 'tu es à jour partout') + '. « Vu » pointe le dernier message affiché : ce qui arrive ensuite revient « à voir ».', rows.length + ' active chats over 14 days (1:1, groups, meetings), whether a session follows them or not · list from ' + ago(data.now - D.at) + ' ago · '
    + (todo ? todo + ' to handle' : 'you are up to date everywhere') + '. "Seen" marks the last message shown: anything that arrives after comes back "to look at".'));
  main.append(meta);
  const box = el('div', 'chats');
  for (const g of groups) {
    if (!g.rows.length && g.key !== 'reply') continue;
    const h = el('div', 'chead', g.title + ' · ' + g.rows.length); if (g.hint) h.append(el('span', 'tx', g.hint));
    if (g.key === 'unseen' && g.rows.length > 1 && canWrite) { const b = el('button', null, T('Tout marquer vu', 'Mark all seen')); b.title = T('Pointe toutes les conversations « à voir » d’un coup (celles où c’est à toi de répondre restent)', 'Marks all "to look at" conversations at once (the ones waiting for your reply stay)'); b.onclick = () => chatSeen('*', 'seen', D.at); h.append(b); }
    box.append(h);
    if (!g.rows.length) box.append(el('div', 'meta', T('Personne n’attend ta réponse.', 'Nobody is waiting for your reply.')));
    for (const r of g.rows) {
      const row = el('div', 'crow g-' + g.key + (chatPicking === r.chatId ? ' picking' : ''));
      const t = el('div', 'ct', (CHAT_ICON[r.type] || '') + ' ' + (r.label || T('(chat sans nom)', '(unnamed chat)'))); t.append(el('span', 'when', T('il y a ' + ago(data.now - r.lastAt), ago(data.now - r.lastAt) + ' ago'))); row.append(t);
      const bs = el('div', 'cb');
      if (r.webUrl) { const l = el('a', null, 'Teams ↗'); l.href = r.webUrl; l.target = '_blank'; l.rel = 'noopener'; l.title = T('Ouvrir la conversation dans Teams', 'Open the conversation in Teams'); bs.append(l); }
      { const b = el('button', null, chatThreads.has(r.chatId) ? T('Replier', 'Collapse') : T('Fil', 'Thread')); b.title = T('Les derniers messages de la conversation, en entier', 'The latest messages of the conversation, in full'); b.onclick = () => chatToggleThread(r.chatId); bs.append(b); }
      if (canSend) { const b = el('button', null, T('Répondre', 'Reply')); b.title = T('Écrire ta réponse ici : elle part dans Teams en ton nom, sans ouvrir Teams', 'Write your reply here: it goes to Teams on your behalf, without opening Teams'); b.onclick = () => { chatReplying.has(r.chatId) ? chatReplying.delete(r.chatId) : chatReplying.add(r.chatId); renderChats(); const ta = main.querySelector('.creply[data-chat="' + CSS.escape(r.chatId) + '"] textarea'); if (ta) ta.focus(); }; bs.append(b); }
      if (canWrite && r.link) { const b = el('button', null, T('Détacher', 'Detach')); b.title = T('La session ne recevra plus les messages de ce fil', 'The session will no longer receive the messages of this thread'); b.onclick = () => chatLink(r.chatId, 'detach'); bs.append(b); }
      else if (canWrite) { const b = el('button', null, T('Confier', 'Hand over')); b.title = T('Confier ce fil à une session : elle reçoit les messages à traiter puis toute la suite, jusqu’au détachement. Elle propose, rien ne part sans toi.', 'Hand this thread over to a session: it receives the messages to handle and everything after, until you detach it. It suggests, nothing is sent without you.'); b.onclick = () => chatPick(r.chatId, null); bs.append(b); }
      if (g.key === 'reply') { const b = el('button', null, T('Rien à répondre', 'Nothing to reply')); b.title = T('Tu as lu, il n’y a rien à répondre : la conversation passe « à jour » jusqu’au prochain message', 'You read it, there is nothing to reply: the conversation is "up to date" until the next message'); b.onclick = () => chatSeen(r.chatId, 'seen', r.lastAt); bs.append(b); }
      else if (g.key === 'unseen') { const b = el('button', null, T('Vu', 'Seen')); b.title = T('Tu as vu ce qui s’est passé ici : la conversation passe « à jour » jusqu’au prochain message', 'You saw what happened here: the conversation is "up to date" until the next message'); b.onclick = () => chatSeen(r.chatId, 'seen', r.lastAt); bs.append(b); }
      else if (r.by !== 'me' && r.by !== 'app') { const b = el('button', null, '↺'); b.title = T('Remettre à voir', 'Mark as to look at again'); b.onclick = () => chatSeen(r.chatId, 'unseen', r.lastAt); bs.append(b); }
      row.append(bs);
      const th = chatThreads.get(r.chatId);
      if (chatThreads.has(r.chatId)) {
        // Fil déplié : les derniers messages, du plus ancien au plus récent (il remplace les messages à lire, qu'il contient).
        const x = el('div', 'cthread');
        if (!th) x.append(el('div', 'tx', T('chargement…', 'loading…')));
        else { if (!th.messages.length || !th.fresh) x.append(el('div', 'tx', th.messages.length ? T('fil pas encore relu depuis le dernier message (prochaine passe du veilleur, 2 min)', 'thread not re-read since the last message yet (next watcher pass, 2 min)') : T('fil pas encore lu par le veilleur (prochaine passe, 2 min)', 'thread not read by the watcher yet (next pass, 2 min)'))); for (const m of th.messages) x.append(chatMsg(m, true, r.chatId, !!r.link)); }
        row.append(x); if (th) requestAnimationFrame(() => { x.scrollTop = x.scrollHeight; });
      } else {
        const m = el('div', 'cm'), news = r.news || [];
        if (news.length > 1) m.append(el('div', 'cnt', T(news.length + ' messages à lire', news.length + ' messages to read')));
        if (news.length) for (const x of news) m.append(chatMsg(x, news.length > 1, r.chatId, !!r.link));
        else {
          const last = chatMsg({ by: r.by, from: r.lastFrom, at: r.lastAt, text: r.excerpt }, false);
          // « À jour » : deux lignes suffisent, un clic donne le message entier.
          if (g.key === 'ok' && !chatWide.has(r.chatId)) { last.classList.add('clamp'); last.title = T('Clic : afficher le message en entier', 'Click: show the whole message'); last.onclick = () => { chatWide.add(r.chatId); renderChats(); }; }
          m.append(last);
        }
        row.append(m);
      }
      const s = el('div', 'cs');
      if (r.ball === 'reply') s.append(el('span', 'tag toreply', T('à toi de répondre', 'your turn to reply') + (r.why ? ' — ' + CHAT_WHY[r.why] : '')));
      else if (r.ball === 'session') s.append(el('span', 'tag ses', r.link ? (r.link.pending ? T('confié — remise à la session en cours', 'handed over — delivery to the session in progress') : T('confié — la session a reçu ce message', 'handed over — the session received this message')) : T('une session a reçu ce message', 'a session received this message')));
      if (r.link && r.ball !== 'session') s.append(el('span', 'tag link', T('🔗 fil confié', '🔗 thread handed over')));
      if (r.link && r.link.lastError) s.append(el('span', 'lerr', T('remise en attente : ', 'delivery pending: ') + r.link.lastError));
      else if (r.ball === 'waiting') s.append(el('span', 'tag wait', T('en attente de leur réponse', 'waiting for their reply')));
      for (const x of r.sessions) {
        const it = allItems().find(i => i.sessionId === x.sessionId && i.kind !== 'run' && i.kind !== 'pass');
        if (it) { const b = el('button', 'chip', label(it) + ' — ' + CHAT_ROLE[x.role]); b.title = T('Ouvrir la session (' + LABEL[it.state] + ')', 'Open the session (' + LABEL[it.state] + ')'); b.onclick = () => select(it.key, true); s.append(b); }
        else { const o = el('span', 'chip gone', T('session fermée — ', 'closed session — ') + CHAT_ROLE[x.role]); o.title = x.sessionId; s.append(o); }
      }
      if (s.childNodes.length) row.append(s);
      if (canWrite && chatPicking === r.chatId && !r.link) {
        const f = el('div', 'cpick'), sel = el('select');
        const o0 = el('option', null, T('➕ Nouvelle session', '➕ New session')); o0.value = 'new'; sel.append(o0);
        for (const it of chatTargets(allItems())) { const o = el('option', null, label(it) + ' — ' + LABEL[it.state]); o.value = it.sessionId; sel.append(o); }
        sel.value = [...sel.options].some(o => o.value === chatPickValue) ? chatPickValue : 'new'; sel.onchange = () => { chatPickValue = sel.value; };
        const note = el('input'); note.type = 'text'; note.maxLength = 1500; note.placeholder = T('Ce que tu en attends (facultatif) — ta consigne à la session', 'What you expect (optional) — your instruction to the session'); note.value = chatPickNote; note.oninput = () => { chatPickNote = note.value; };
        const fl = el('label'), cb = el('input'); cb.type = 'checkbox'; cb.checked = chatPickFollow; cb.onchange = () => { chatPickFollow = cb.checked; }; fl.append(cb, T('lui remettre aussi la suite du fil', 'also hand it the rest of the thread')); fl.title = T('Coché : la session reçoit tous les prochains messages du fil, jusqu’au « Détacher ». Décoché : une seule remise.', 'Checked: the session gets every next message of the thread, until "Detach". Unchecked: a single handover.');
        const ok = el('button', null, T('Confier', 'Hand over')); ok.title = T('Entrée', 'Enter'); ok.onclick = () => chatLink(r.chatId, 'attach', sel.value);
        const no = el('button', null, T('Annuler', 'Cancel')); no.title = T('Échap', 'Esc'); no.onclick = () => { chatPickClose(); renderChats(); };
        const picks = [...chatPickAnchors.values()], one = picks[0];
        f.append(picks.length > 1 ? el('span', 'from', T('À partir des ' + picks.length + ' messages retenus → ', 'From the ' + picks.length + ' picked messages → ')) : one ? el('span', 'from', T('À partir du message de ' + one.who + ' (il y a ' + ago(data.now - one.at) + ') → ', 'From the message of ' + one.who + ' (' + ago(data.now - one.at) + ' ago) → ')) : T('Confier ce fil à ', 'Hand this thread to '), sel, note, fl, ok, no,
          el('span', 'tx', picks.length ? T('elle reçoit ' + (picks.length > 1 ? 'ces messages' : 'ce message') + ', ce qui l’entoure et ta consigne · « + ajouter » sur d’autres messages (ou « Fil » pour les plus anciens) pour compléter', 'it gets ' + (picks.length > 1 ? 'these messages' : 'this message') + ', what surrounds them and your instruction · "+ add" on other messages (or "Thread" for older ones) to complete') : T('elle reçoit les messages à traiter et ta consigne · ou « → session » sur les messages à retenir', 'it gets the messages to handle and your instruction · or "→ session" on the messages to pick')));
        row.append(f);
      }
      if (canSend && chatReplying.has(r.chatId)) {
        const f = el('div', 'creply'); f.dataset.chat = r.chatId;
        const ta = el('textarea'); ta.placeholder = T('Ta réponse à ' + (r.label || 'ce chat') + '…', 'Your reply to ' + (r.label || 'this chat') + '…'); ta.value = chatDrafts.get(r.chatId) || ''; ta.spellcheck = true;
        ta.oninput = () => chatDrafts.set(r.chatId, ta.value);
        const rb = el('div', 'rb'), busy = chatSending === r.chatId;
        const ok = el('button', null, busy ? T('Envoi…', 'Sending…') : T('Envoyer', 'Send')); ok.disabled = !!chatSending; ok.title = T('Poste ce message dans Teams, en ton nom  ( Ctrl+Entrée )', 'Posts this message in Teams, on your behalf  ( Ctrl+Enter )'); ok.onclick = () => chatSend(r.chatId);
        const no = el('button', null, T('Annuler', 'Cancel')); no.title = T('Referme sans envoyer (le brouillon est gardé)  ( Échap )', 'Closes without sending (the draft is kept)  ( Esc )'); no.onclick = () => { chatReplying.delete(r.chatId); renderChats(); };
        rb.append(ok, no, el('span', 'tx', T('part dans Teams en ton nom, tel quel · Ctrl+Entrée pour envoyer', 'goes to Teams on your behalf, as is · Ctrl+Enter to send')));
        f.append(ta, rb); row.append(f);
      }
      box.append(row);
    }
  }
  main.append(box); main.scrollTop = keep;
  if (focId) { const ta = main.querySelector('.creply[data-chat="' + CSS.escape(focId) + '"] textarea'); if (ta) { ta.focus(); try { ta.setSelectionRange(sel[0], sel[1]); } catch {} } }
}

// ── Lanceur (🤖) : supervision des claude -p du diagnostic automatique — santé, runs en cours, tickets qui attendent,
// runs récents par phase avec leurs fichiers (texte brut / captures) et la conversation à rouvrir. Rafraîchi toutes les 10 s. ──
let launchMode = false, launchData = null, launchHours = 48, launchTimer = null, launchView = null, launchViewText = null, launchFilter = '';
const STAGE_FR = { 'pr-awaiting-approval':T('PR en attente de validation', 'PR awaiting approval'), 'delivering':T('livraison en cours', 'delivery in progress'), 'deploying':T('en déploiement', 'deploying'), 'dev-failed':T('dev en échec', 'dev failed'), 'diagnosis-held':T('diagnostic posé', 'diagnosis posted'),
  'in-production':T('en production', 'in production'), 'diagnosis-skipped':T('diagnostic écarté', 'diagnosis skipped'), 'dev-abandoned':T('dev abandonné', 'dev abandoned'), 'pr-closed':T('PR fermée', 'PR closed') };
const PHASE_FR = { diagnostic:T('diagnostic', 'diagnosis'), go:'go', dev:'dev', recette:T('recette', 'testing'), relecture:T('relecture', 'code review'), reprise:T('reprise', 'rework'), merge:'merge' };
function openLauncher() { if (launcherOff()) return; findMode = false; newMode = false; bcMode = false; boardMode = false; chatsMode = false; selected = null; sessionStorage.removeItem('cc.sel'); launchMode = true; setPane(true);
  clearInterval(launchTimer); launchTimer = setInterval(loadLauncher, 10000); renderList(); renderDetail(true); loadLauncher(); }
function closeLauncher() { launchMode = false; setPane(false); clearInterval(launchTimer); renderDetail(true); }
async function loadLauncher() {
  if (!launchMode) { clearInterval(launchTimer); return; }
  try { launchData = await (await fetch('/api/launcher?hours=' + launchHours, { cache:'no-store' })).json(); if (launchMode) renderLauncher(); } catch { say(T('lanceur illisible', 'could not read the launcher')); }
}
async function viewLaunchFile(dir, name) {
  const key = dir + '/' + name; if (launchView === key) { launchView = null; launchViewText = null; return renderLauncher(); }
  launchView = key; launchViewText = name.endsWith('.png') ? null : '…'; renderLauncher();
  if (!name.endsWith('.png')) { try { launchViewText = await (await fetch('/api/launcher/file?path=' + encodeURIComponent(dir + '\\' + name), { cache:'no-store' })).text(); } catch { launchViewText = T('(illisible)', '(unreadable)'); } renderLauncher(); }
}
async function openRunConversation(r) {
  if (!r.sessionId) return say(T('identifiant de session inconnu pour ce run', 'unknown session id for this run'));
  if (!confirm(T('Rouvrir la conversation du run ' + (PHASE_FR[r.phase] || r.phase) + ' de HD-' + r.hd + ' dans un nouvel onglet (claude --resume) ?\n\nPour l’inspecter ou la questionner. Le lanceur ne la reprend pas : ce que tu y fais ne change pas son run.', 'Reopen the conversation of the ' + (PHASE_FR[r.phase] || r.phase) + ' run of HD-' + r.hd + ' in a new tab (claude --resume)?\n\nTo inspect or question it. The launcher does not resume it: what you do there does not change its run.'))) return;
  try { const x = await post('/api/reopen?id=' + r.sessionId); say(x.error ? T('refusé : ', 'refused: ') + x.error : T('onglet ouvert — la session apparaît dans quelques secondes', 'tab opened — the session appears in a few seconds')); } catch { say(T('échec de la demande', 'request failed')); }
}
function renderLauncher() {
  const main = $('main'); const L = launchData; detailKey = '__launch__';
  const keepScroll = main.scrollTop; main.replaceChildren();
  main.append(el('div', 'dtitle', T('Lanceur — diagnostic automatique', 'Launcher — automatic diagnosis')));
  if (!L) { main.append(el('div', 'meta', T('chargement…', 'loading…'))); return; }
  if (!L.present) { main.append(el('div', 'empty', T('Lanceur absent de ce poste.', 'No launcher on this machine.'))); return; }
  main.append(el('div', 'meta', T('Modes : triage ' + L.triage + ' · dev ' + L.devMode + ' · recette ' + L.recetteMode + ' · reprise ' + L.reworkMode + ' · coût des runs affichés : ' + L.cost.toLocaleString(LOCALE) + ' $', 'Modes: triage ' + L.triage + ' · dev ' + L.devMode + ' · testing ' + L.recetteMode + ' · rework ' + L.reworkMode + ' · cost of the runs shown: $' + L.cost.toLocaleString('en-GB'))));
  // Santé
  const hb = L.heartbeat ? L.now - L.heartbeat : null;
  const tiles = el('div', 'tiles');
  const th = el('div', 'tile ' + (hb != null && hb < 5 * 60000 ? 'busy' : 'waiting')); th.append(el('b', null, hb == null ? '?' : ago(hb)), el('span', null, T('depuis son dernier battement' + (hb != null && hb >= 5 * 60000 ? ' — arrêté ?' : ''), 'since its last heartbeat' + (hb != null && hb >= 5 * 60000 ? ' — stopped?' : '')))); tiles.append(th);
  for (const q of L.quota || []) {
    // Remise à zéro déjà passée : le relevé de ce compte n'a pas été rafraîchi par le lanceur — on le dit.
    const stale = q.weeklyResetsAt && new Date(q.weeklyResetsAt).getTime() < L.now;
    if (stale) { const t = el('div', 'tile idle'); t.append(el('b', null, (q.weeklyPct ?? '?') + ' % ?'), el('span', null, T('quota ' + (q.alias || '') + ' · relevé périmé (remise du ' + new Date(q.weeklyResetsAt).toLocaleDateString(LOCALE) + ' passée)', 'quota ' + (q.alias || '') + ' · outdated reading (reset of ' + new Date(q.weeklyResetsAt).toLocaleDateString('en-GB') + ' passed)'))); tiles.append(t); continue; }
    const t = el('div', 'tile ' + qLevel(q.weeklyPct, 'idle')); t.append(el('b', null, (q.weeklyPct ?? '?') + ' %'), el('span', null, T('quota semaine ', 'weekly quota ') + (q.alias || '') + (q.weeklyResetsAt ? T(' · remise ', ' · reset ') + new Date(q.weeklyResetsAt).toLocaleString(LOCALE, { weekday:'short', hour:'2-digit', minute:'2-digit' }) : ''))); tiles.append(t);
    // Limite propre à un modèle (« Fable ») : sa tuile, mêmes seuils.
    for (const l of (q.limits || []).filter(l => l.model && l.pct != null)) { const tm = el('div', 'tile ' + qLevel(l.pct, 'idle')); tm.append(el('b', null, Math.round(l.pct) + ' %'), el('span', null, T('quota semaine ', 'weekly quota ') + l.model + ' ' + (q.alias || ''))); tiles.append(tm); } }
  const running = L.runs.filter(r => r.running);
  const tr = el('div', 'tile busy'); tr.append(el('b', null, running.length), el('span', null, T('run(s) en cours', 'run(s) in progress'))); tiles.append(tr);
  const tw = el('div', 'tile ask'); tw.append(el('b', null, L.waiting.length), el('span', null, T('ticket(s) qui attendent', 'waiting ticket(s)'))); tiles.append(tw);
  main.append(tiles);
  const errs = (L.errors || []).filter(e => L.now - e.at < 7 * 86400000);
  if (errs.length) {
    main.append(el('h2', null, T('Dernières erreurs du lanceur', 'Latest launcher errors')));
    const box = el('div', 'notifs');
    for (const e of errs) { const d = el('div', 'notif ' + (L.now - e.at < 86400000 ? 'waiting' : 'idle')); d.style.cursor = 'default'; d.append(el('span', 'dot'), el('span', 'when', T('il y a ' + ago(L.now - e.at), ago(L.now - e.at) + ' ago')), el('span', 'nt', e.kind), el('span', 'nx', e.message)); box.append(d); }
    main.append(box);
  }
  // En cours
  main.append(el('h2', null, T('En cours — ', 'In progress — ') + running.length));
  if (!running.length) main.append(el('div', 'empty', T('Aucun claude -p du lanceur ne tourne.', 'No launcher claude -p is running.')));
  for (const r of running) {
    const c = el('div', 'fhit busy'); const t = el('div', 'ft'); t.append(el('span', 'dot'), el('span', null, 'HD-' + r.hd + ' · ' + (PHASE_FR[r.phase] || r.phase) + ' — ' + (r.title || '')), el('span', 'n', T('depuis ', 'for ') + ago(L.now - r.at) + (r.tokens ? ' · ' + ktok(r.tokens) : '') + ' · pid ' + r.pid)); c.append(t);
    if (r.reply) c.append(el('div', 'snip', tailOf(r.reply).slice(-400)));
    if (r.liveSessionId) { const a = el('div', 'actions'); const b = el('button', null, T('Voir la session', 'View the session')); b.onclick = () => select(r.liveSessionId, true); a.append(b); c.append(a); }
    main.append(c);
  }
  // Tickets qui attendent
  main.append(el('h2', null, T('Tickets qui attendent — ', 'Waiting tickets — ') + L.waiting.length));
  if (L.waiting.length) {
    const w = el('div', 'tablewrap'), tb = el('table'), hr = el('tr'); [T('Depuis', 'Since'), 'Ticket', T('Étape', 'Stage'), T('Attend', 'Waiting on'), 'PR', T('Détail', 'Detail')].forEach(h => hr.append(el('th', null, h))); tb.append(hr);
    for (const x of L.waiting) { const r = el('tr'); r.append(el('td', null, x.since ? T('il y a ' + ago(L.now - x.since), ago(L.now - x.since) + ' ago') : ''), el('td', null, 'HD-' + x.hd + ' ' + (x.title || '')), el('td', null, STAGE_FR[x.stage] || x.stage), el('td', null, x.waitingOn || ''));
      const pc = el('td'); if (x.prUrl && /^https:\/\/github\.com\//.test(x.prUrl)) { const a = el('a', null, '#' + x.prNumber); a.href = x.prUrl; a.target = '_blank'; a.rel = 'noopener'; pc.append(a); } r.append(pc, el('td', null, x.detail || '')); tb.append(r); }
    w.append(tb); main.append(w);
  } else main.append(el('div', 'empty', T('Aucun.', 'None.')));
  // Décisions de la Tech en attente (carte ✅ sous la dernière note) : ouvrir le run pour trancher
  const decs = L.decisions || [];
  main.append(el('h2', null, T('Décisions de la Tech en attente — ', 'Pending tech decisions — ') + decs.length));
  if (decs.length) {
    const w = el('div', 'tablewrap'), tb = el('table'), hr = el('tr'); [T('Depuis', 'Since'), 'Ticket', T('Carte', 'Card'), 'Question', ''].forEach(h => hr.append(el('th', null, h))); tb.append(hr);
    for (const x of decs) { const f = decisionForm(x); const r = el('tr');
      r.append(el('td', null, x.since ? T('il y a ' + ago(L.now - x.since), ago(L.now - x.since) + ' ago') : ''), el('td', null, 'HD-' + x.hd + ' ' + (x.title || '')), el('td', null, f.title), el('td', null, f.question));
      const c = el('td'); const b = el('button', null, T('Trancher', 'Decide')); b.onclick = () => openRun(String(x.hd)); c.append(b); r.append(c); tb.append(r); }
    w.append(tb); main.append(w);
  } else main.append(el('div', 'empty', T('Aucune.', 'None.')));
  // Runs récents
  const hh = el('h2', null, 'Runs — ' + (launchHours <= 48 ? T('48 dernières heures', 'last 48 hours') : T('7 derniers jours', 'last 7 days')) + ' · ' + L.runs.length + ' '); const sw = el('a', null, launchHours <= 48 ? T('voir 7 jours', 'show 7 days') : T('revenir à 48 h', 'back to 48 h')); sw.href = '#'; sw.style.textTransform = 'none'; sw.style.fontWeight = '400';
  sw.onclick = e => { e.preventDefault(); launchHours = launchHours <= 48 ? 168 : 48; launchData = null; renderLauncher(); loadLauncher(); }; hh.append(sw); main.append(hh);
  const fi = el('input'); fi.className = 'lfilter'; fi.placeholder = T('filtrer : HD, titre, phase, résultat…', 'filter: ticket, title, phase, outcome…'); fi.value = launchFilter; fi.oninput = () => { launchFilter = fi.value; renderLauncher(); const n = document.querySelector('.lfilter'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }; main.append(fi);
  const toks = norm(launchFilter).split(/\s+/).filter(Boolean);
  const runs = L.runs.filter(r => toks.every(t => norm(['HD-' + r.hd, r.title, r.phase, r.outcome, r.verdict, r.detail, r.stage].join(' ')).includes(t)));
  const list = el('div', 'lruns');
  for (const r of runs) {
    const ok = /^(posted|ready|pr-open|merged|ok|success|done|in-production)$/i.test(r.outcome || '') && r.verdict !== 'a-reprendre';
    const ko = /fail|abandon|error|refus|denied/i.test((r.outcome || '') + ' ' + (r.verdict || ''));
    const row = el('div', 'lrun ' + (r.running ? 'busy' : ko ? 'waiting' : ok ? 'done' : 'idle'));
    const h = el('div', 'lh');
    h.append(el('span', 'dot'), el('span', 'lt', new Date(r.at).toLocaleString(LOCALE, { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })), el('span', 'lp', PHASE_FR[r.phase] || r.phase),
             el('span', 'lx', 'HD-' + r.hd + ' — ' + (r.title || '')),
             el('span', 'lo', r.running ? T('en cours', 'running') : [r.outcome, r.verdict].filter(Boolean).join(' · ') || '—'),
             el('span', 'lm', [r.minutes != null ? Math.round(r.minutes) + ' min' : null, r.turns ? r.turns + T(' tours', ' turns') : null, r.costUsd != null ? T((Math.round(r.costUsd * 100) / 100).toLocaleString(LOCALE) + ' $', '$' + (Math.round(r.costUsd * 100) / 100).toLocaleString('en-GB')) : null].filter(Boolean).join(' · ')));
    row.append(h);
    if (r.detail) row.append(el('div', 'ld', r.detail));
    { const lv = r.running ? runLiveLine(r.live, Date.now()) : null;
      if (lv) row.append(el('div', 'ld runlive-l' + (lv.stale ? ' stale' : ''), [lv.stale ? '⚠️ ' + lv.moved : null, lv.text, lv.todos].filter(Boolean).join(' · '))); }
    const fl = el('div', 'lf');
    for (const f of r.files) { const b = el('button', 'quick' + (launchView === r.dir + '/' + f.name ? ' on' : ''), f.name); b.title = Math.max(1, Math.round(f.size / 1024)) + T(' Ko', ' KB'); b.onclick = () => viewLaunchFile(r.dir, f.name); fl.append(b); }
    if (r.sessionId && !r.running) { const b = el('button', 'quick', '↻ conversation'); b.title = T('Rouvrir cette conversation dans un onglet (claude --resume ' + r.sessionId.slice(0, 8) + '…)', 'Reopen this conversation in a tab (claude --resume ' + r.sessionId.slice(0, 8) + '…)'); b.onclick = () => openRunConversation(r); fl.append(b); }
    row.append(fl);
    if (launchView && launchView.startsWith(r.dir + '/')) {
      const name = launchView.slice(r.dir.length + 1);
      if (name.endsWith('.png')) { const img = el('img', 'lview'); img.src = '/api/launcher/file?path=' + encodeURIComponent(r.dir + '\\' + name); row.append(img); }
      else row.append(el('pre', 'lview', launchViewText));
    }
    list.append(row);
  }
  if (!runs.length) list.append(el('div', 'empty', T('Aucun run.', 'No run.')));
  main.append(list);
  main.scrollTop = keepScroll;
}

// ── Runs du lanceur DANS LA LISTE (groupe 🤖) : une ligne par DEMANDE (runsByHd, plus bas) regroupant ses runs du jour (depuis minuit) et tout run en cours, avec le
// détail d'une session manuelle (conversation, fichiers, coût, PR). Lecture seule. Source : /api/launcher?hours=24, relu
// toutes les 30 s page visible (le serveur garde 15 s en cache) — aucune route nouvelle. Cadrage :
// le cadrage.
// launcherGroup est PURE (testée par sessions-dashboard-tests.ps1) : runs → éléments de liste ; la session headless
// d'un run en cours (même pid, ou même sessionId) est ABSORBÉE par lui — elle ne figure plus seule dans la liste.
// Étapes scriptées (go, merge, production, doc : pas de claude -p) : ligne sans conversation.
// Couleur (look) : en cours = busy · échec = waiting · PR qui attend la validation de l'utilisateur = ask · réussi = done.
// « Attend l'utilisateur » ne colore que le DERNIER run de la demande : les plus anciens ont fini leur part.
function launcherGroup(runs, waiting, open, since) {
  const SCRIPTED = ['go', 'merge', 'production', 'doc'];
  const KO = /fail|abandon|error|erreur|refus|denied|timeout|crash/i, OK = /^(posted|ready|pr-open|merged|ok|success|done|in-production)$/i;
  const wait = new Map((waiting || []).map(w => [String(w.hd), w]));
  const live = new Map();
  for (const s of open || []) if (s.headless) { if (s.pid) live.set('pid:' + s.pid, s); if (s.sessionId) live.set('sid:' + s.sessionId, s); }
  const latest = new Map();
  for (const r of runs || []) if (!latest.has(String(r.hd)) || latest.get(String(r.hd)).at < r.at) latest.set(String(r.hd), r);
  const items = [], absorbed = new Set();
  for (const r of runs || []) {
    if (!r.running && !(r.at >= since)) continue;
    const s = (r.pid && live.get('pid:' + r.pid)) || (r.liveSessionId && live.get('sid:' + r.liveSessionId)) || null;
    if (s) absorbed.add(s.sessionId);
    const w = latest.get(String(r.hd)) === r ? wait.get(String(r.hd)) || null : null;
    const o = [r.outcome, r.verdict].filter(Boolean).join(' · ');
    const look = r.running ? 'busy' : KO.test(o) || (w && w.stage === 'dev-failed') ? 'waiting' : w && w.stage === 'pr-awaiting-approval' ? 'ask'
      : OK.test(r.outcome || '') && r.verdict !== 'a-reprendre' ? 'done' : 'idle';
    const sessionId = (s && s.sessionId) || r.liveSessionId || r.sessionId || null;
    items.push({ kind:'run', key:'run:' + r.dir, run:r, wait:w, look, sessionId, scripted: SCRIPTED.includes(r.phase) && !sessionId,
      title: 'HD-' + r.hd + ' · ' + r.phase + (r.title ? ' — ' + r.title : ''), outcome: r.running ? T('en cours', 'running') : o,
      at: r.at, since: r.running || r.minutes == null ? r.at : r.at + Math.round(r.minutes * 60000),
      model: (s && s.model) || r.model || null, tokens: (s && s.tokens) || r.tokens || null, reply: (s && s.reply) || r.reply || null,
      pid: r.pid || null, cwd: s ? s.cwd : null,
      pr: w && w.prNumber ? w.prNumber : null, prUrl: w && w.prUrl ? w.prUrl : null });
  }
  items.sort((a, b) => (b.run.running - a.run.running) || b.at - a.at);
  return { items, absorbed };
}
// Une ligne par DEMANDE, pas par run : un HD qui passe diagnostic → dev → relecture → recette → merge faisait 5 lignes.
// runsByHd est PURE (testée par sessions-dashboard-tests.ps1) : éléments de launcherGroup → un élément par HD, qui
// REPREND le run en cours s'il y en a un, sinon le plus récent (titre, couleur, PR, conversation), et porte la liste de
// ses runs (du plus récent au plus ancien), leur enchaînement de phases et leur coût cumulé. Clé stable `hd:<n>` : la
// sélection survit au run suivant de la même demande.
function runsByHd(items) {
  const by = new Map();
  for (const it of items || []) { const k = String(it.run.hd); if (!by.has(k)) by.set(k, []); by.get(k).push(it); }
  const out = [];
  for (const [hd, list] of by) {
    list.sort((a, b) => b.at - a.at);
    const head = list.find(i => i.run.running) || list[0];
    const withPr = list.find(i => i.pr);
    const costs = list.filter(i => i.run.costUsd != null);
    out.push({ ...head, key: 'hd:' + hd, runs: list, runCount: list.length, phases: list.map(i => i.run.phase).reverse(),
      costTotal: costs.length ? Math.round(costs.reduce((s, i) => s + i.run.costUsd, 0) * 100) / 100 : null,
      pr: head.pr || (withPr ? withPr.pr : null), prUrl: head.prUrl || (withPr ? withPr.prUrl : null) });
  }
  out.sort((a, b) => (b.run.running - a.run.running) || b.at - a.at);
  return out;
}
// Run de la demande affiché dans le détail : le run choisi dans la frise (clé de groupe → dossier du run), sinon celui
// que reprend la ligne.
const runPick = new Map();
function pickRun(it) {
  if (!it || !it.runs) return it;
  const dir = runPick.get(it.key), sub = dir && it.runs.find(r => r.run.dir === dir);
  return sub && sub.run.dir !== it.run.dir ? { ...sub, key: it.key, runs: it.runs, runCount: it.runCount, phases: it.phases, costTotal: it.costTotal, picked: true } : it;
}
let runData = null, runTimer = null, runsRead = false, heldRun = null;   // runsRead : 1re lecture faite (une adresse ?sel=hd:… attend jusque-là)
const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
// Module « launcher » éteint (le serveur le dit dans data.modules ; le .ps1 ne dit rien : il l'a toujours).
const launcherOff = () => !!(data && data.modules && !data.modules.launcher);
async function loadRuns() {
  if (launcherOff()) { runData = null; return; }
  if (document.visibilityState === 'hidden' && runData) return;
  try { const r = await (await fetch('/api/launcher?hours=24', { cache:'no-store' })).json(); runData = r && r.present ? r : null; runsRead = true; if (data) { renderList(); renderDetail(); } } catch {}
  runsRead = true;
  if (pendingRun && data && runData) { const hd = pendingRun; pendingRun = null; openRun(hd); }
}
// Notification « HD-x t'attend » (cloche ou notification Windows ?run=x) : le DERNIER run de la demande, dans la liste ;
// à défaut (run d'avant minuit), la vue 🤖.
let pendingRun = new URLSearchParams(location.search).get('run');
function openRun(hd) {
  const it = allItems().filter(i => i.kind === 'run' && String(i.run.hd) === String(hd)).sort((a, b) => b.at - a.at)[0];
  if (!it) { openLauncher(); return; }
  if (launchMode) closeLauncher();
  runPick.delete(it.key);
  select(it.key, true);
}
const runGroup = () => {
  const runs = runData ? runData.runs : [], waiting = runData ? runData.waiting : [], open = data ? data.sessions : [], cards = cardsOn() ? runData.cards || [] : [];
  const g = launcherGroup(runs, waiting, open, midnight());
  // Une carte qui attend garde sa demande dans la liste, même si son dernier run date d'avant minuit.
  const old = cardRuns(runs, cards, midnight()), g2 = old.length ? launcherGroup(old, waiting, open, 0) : { items: [] };
  const k = keepSelectedRun(withCards(runsByHd(g.items.concat(g2.items)), cards), heldRun, selected);
  heldRun = k.held;
  return { items: k.items, absorbed: g.absorbed };
};
// La demande OUVERTE dans le détail ne quitte pas la liste sous l'utilisateur. Une demande dont le dernier run date
// d'avant minuit n'y tient que par sa carte : la carte répondue (ou le feu vert donné), elle en sortait, la sélection
// tombait et la page revenait à la vue d'ensemble, le temps que le run suivant apparaisse. On garde la dernière copie
// vue de la demande sélectionnée (sans ses cartes, déjà traitées) jusqu'à ce que le lanceur la renvoie ou qu'on en
// sélectionne une autre. PURE (testée par server/test/page-cards.test.ts).
function keepSelectedRun(items, held, sel) {
  if (!sel || !String(sel).startsWith('hd:')) return { items, held: null };
  const cur = items.find(i => i.key === sel);
  if (cur) return { items, held: cur };
  if (!held || held.key !== sel) return { items, held: null };
  const { cards, ...rest } = held;
  const kept = { ...rest, look: rest.run && rest.run.running ? rest.look : 'idle' };
  return { items: items.concat(kept), held: kept };
}
const money = v => (Math.round(v * 100) / 100).toLocaleString(LOCALE) + ' $';
// ── Passes des AUTOMATES du poste (module « automations ») : scripts planifiés déclarés dans la configuration du
// poste. Un groupe par automate dans la liste (la passe en cours et la DERNIÈRE passe du jour qui a agi ou échoué), une carte
// par automate dans la vue d'ensemble, le détail d'une passe (résumé, fichiers, conversation). Source :
// /api/automations?since=<minuit>, relu toutes les 30 s page visible et juste après un « Lancer maintenant ».
// Les passes sans effet (quiet) n'ont pas de ligne : l'en-tête du groupe les compte et redit la dernière.
let autoData = null, autoAsked = false;
const automationsOff = () => !(data && data.modules && data.modules.automations);
async function loadAutomations() {
  if (automationsOff()) { autoData = null; return; }
  if (document.visibilityState === 'hidden' && autoData) return;
  autoAsked = true;
  try { const r = await fetch('/api/automations?since=' + midnight(), { cache:'no-store' }); autoData = r.ok ? await r.json() : null; if (data) { renderList(); renderDetail(); } } catch {}
  if (pendingPass && autoData) { const p = pendingPass; pendingPass = null; openPass(p); }
}
// automationGroups est PURE (testée par server/test/automations-page.test.ts) : vue du serveur → un groupe par
// automate et ses éléments de liste. La session sans terminal de la passe en cours (même sessionId, ou même pid) est
// ABSORBÉE par la ligne de la passe : elle ne figure plus seule dans la liste.
// Une seule passe terminée par automate : la plus récente (l'historique du jour se lit dans la carte et l'en-tête).
// `keep` : clés de passes à garder quand même (la passe sélectionnée, celle qu'un lien de notification ouvre).
// Couleur (look) : en cours = busy · passe en erreur = waiting · alerte = ask · à blanc = idle · réussie = done.
function automationGroups(autos, open, keep) {
  const look = p => p.level === 'error' ? 'waiting' : p.level === 'warn' ? 'ask' : p.status === 'dry-run' ? 'idle' : 'done';
  const groups = [], items = [], absorbed = new Set();
  for (const a of autos || []) {
    const name = (a.icon ? a.icon + ' ' : '') + a.label;
    groups.push({ key:'automation:' + a.id, title:name, states:['auto:' + a.id], auto:a });
    if (a.running) {
      const s = (open || []).find(x => x.headless && (x.sessionId === a.running.sessionId || (a.running.pid && x.pid === a.running.pid))) || null;
      if (s) absorbed.add(s.sessionId);
      items.push({ kind:'pass', key:'pass:' + a.id + ':' + a.running.run, auto:a, pass:null, running:true, look:'busy', sessionId:a.running.sessionId,
        title:name + T(' · passe en cours', ' · pass running'), at:a.running.at, since:a.running.at, model:s ? s.model || null : null, tokens:s ? s.tokens || null : null, reply:s ? s.reply || null : null });
    }
    let shown = 0;
    for (const p of a.passes || []) {
      if (a.running && p.run === a.running.run) continue;
      if (shown++ && !(keep || []).includes('pass:' + a.id + ':' + p.run)) continue;
      items.push({ kind:'pass', key:'pass:' + a.id + ':' + p.run, auto:a, pass:p, running:false, look:look(p), sessionId:p.sessionId || null,
        title:name + ' · ' + new Date(p.at).toLocaleTimeString(LOCALE, { hour:'2-digit', minute:'2-digit' }), at:p.at, since:p.at + Math.round((p.minutes || 0) * 60000) });
    }
  }
  return { groups, items, absorbed };
}
let passKeep = null;      // passe qu'un lien de notification demande d'ouvrir, gardée dans la liste même si ce n'est plus la dernière
const autoGroup = () => automationGroups(autoData ? autoData.automations : [], data ? data.sessions : [], [selected, passKeep]);
// Groupes de la liste : ceux de la page, plus un par automate, juste avant « Fermées ».
const groupList = () => { const ag = autoGroup().groups; if (!ag.length) return GROUPS; const i = GROUPS.findIndex(g => g.key === 'closed'); return GROUPS.slice(0, i).concat(ag, GROUPS.slice(i)); };
const PASS_FR = { ok:T('a agi', 'acted'), nothing:T('rien à faire', 'nothing to do'), 'dry-run':T('à blanc', 'dry run'), conflict:T('conflit', 'conflict'), rejected:T('refusée', 'rejected'), failed:T('échec', 'failed'), unknown:T('issue inconnue', 'unknown outcome') };
function passSub(it) {
  if (it.running) return [T('travaille' + (it.at ? ' depuis ' + ago(Date.now() - it.at) : ''), 'working' + (it.at ? ' for ' + ago(Date.now() - it.at) : '')), it.reply ? lastLine(it.reply) : null].filter(Boolean).join(' · ');
  const p = it.pass;
  return [p.summary, p.minutes != null ? (p.minutes < 1 ? '< 1 min' : Math.round(p.minutes) + ' min') : null, p.costUsd != null ? money(p.costUsd) : null].filter(Boolean).join(' · ');
}
// En-tête d'un groupe d'automate : passe en cours, dernière passe (et son résumé si elle était sans effet), passes
// sans effet du jour.
function autoGroupTitle(a) {
  const parts = [];
  if (a.running) parts.push(T('en cours', 'running'));
  if (a.last) parts.push(T('dernière il y a ' + ago(Date.now() - a.last.at) + (a.last.quiet ? ' : ' + a.last.summary : ''), 'last ' + ago(Date.now() - a.last.at) + ' ago' + (a.last.quiet ? ': ' + a.last.summary : '')));
  else if (!a.present) parts.push(T('historique absent', 'no history'));
  if (a.quietToday) parts.push(T(a.quietToday + ' sans effet aujourd’hui', a.quietToday + ' with no effect today'));
  return parts.length ? parts.join(' · ') : '';
}
// automationCard est PURE (testée par server/test/automations-page.test.ts) : la carte d'un automate dans la vue
// d'ensemble — couleur, résumé de la dernière passe, et les lignes « dernière passe », « prochaine », « 7 jours »,
// « dernier échec ».
function automationCard(a, now) {
  const fr = { ok:T('a agi', 'acted'), nothing:T('rien à faire', 'nothing to do'), 'dry-run':T('à blanc', 'dry run'), conflict:T('conflit', 'conflict'), rejected:T('refusée', 'rejected'), failed:T('échec', 'failed'), unknown:T('issue inconnue', 'unknown outcome') };
  const since = ms => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? m + ' min' : m < 2880 ? Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') : Math.floor(m / 1440) + T(' j', ' d'); };
  const usd = v => (Math.round(v * 100) / 100).toLocaleString(LOCALE) + ' $';
  const l = a.last, w = a.week || {};
  const look = a.running ? 'busy' : !a.present || !l ? 'idle' : l.level === 'error' ? 'waiting' : l.level === 'warn' || a.late ? 'ask' : 'done';
  const lines = [];
  if (!a.present) lines.push([T('historique', 'history'), T('introuvable — l’automate a-t-il déjà tourné ? (chemin dans la configuration du poste)', 'not found — has the automation ever run? (path in the configuration of this machine)')]);
  if (a.running) lines.push([T('en cours', 'running'), T('depuis ' + since(now - a.running.at), 'for ' + since(now - a.running.at))]);
  if (l) lines.push([T('dernière passe', 'last pass'), T('il y a ' + since(now - l.at), since(now - l.at) + ' ago') + ' · ' + (fr[l.status] || l.status) + (l.dryRun && l.status !== 'dry-run' ? T(' (à blanc)', ' (dry run)') : '')]);
  if (a.late) lines.push([T('en retard', 'late'), (l ? T('aucune passe depuis ' + since(now - l.at), 'no pass for ' + since(now - l.at)) : T('aucune passe', 'no pass')) + T(' — la tâche planifiée tourne toutes les ' + a.everyMinutes + ' min', ' — the scheduled task runs every ' + a.everyMinutes + ' min')]);
  else if (a.next && !a.running) lines.push([T('prochaine', 'next'), T('dans ' + since(a.next - now), 'in ' + since(a.next - now))]);
  if (w.count) lines.push([T('7 jours', '7 days'), [w.count + (w.count > 1 ? ' passes' : T(' passe', ' pass')), w.failures ? w.failures + (w.failures > 1 ? T(' échecs', ' failures') : T(' échec', ' failure')) : T('aucun échec', 'no failure'),
    w.warnings ? w.warnings + (w.warnings > 1 ? T(' alertes', ' warnings') : T(' alerte', ' warning')) : null, w.costUsd != null ? usd(w.costUsd) + T(' (' + usd(w.costAvg) + ' par passe)', ' (' + usd(w.costAvg) + ' per pass)') : null].filter(Boolean).join(' · ')]);
  if (w.lastFailure) lines.push([T('dernier échec', 'last failure'), T('il y a ' + since(now - w.lastFailure.at) + ' : ' + w.lastFailure.summary, since(now - w.lastFailure.at) + ' ago: ' + w.lastFailure.summary)]);
  return { look, title:(a.icon ? a.icon + ' ' : '') + a.label, summary: l ? l.summary : a.running ? T('première passe en cours', 'first pass running') : T('aucune passe sur 8 jours', 'no pass in 8 days'), lines };
}
function automationSection() {
  const list = autoData ? autoData.automations : []; if (!list.length) return null;
  const box = el('div', 'qcards');
  for (const a of list) {
    const v = automationCard(a, Date.now());
    const c = el('div', 'qcard acard ' + v.look);
    const h = el('div', 'qhead'); h.append(el('b', null, v.title)); c.append(h);
    const sm = el('div', 'asum', v.summary);
    const it = a.running ? allItems().find(x => x.kind === 'pass' && x.running && x.auto.id === a.id) : a.last && allItems().find(x => x.key === 'pass:' + a.id + ':' + a.last.run);
    if (it) { sm.classList.add('lnk'); sm.title = T('Ouvrir cette passe', 'Open this pass'); sm.onclick = () => select(it.key, true); }
    c.append(sm);
    const dl = el('dl'); for (const [k, x] of v.lines) dl.append(el('dt', null, k), el('dd', null, x)); c.append(dl);
    const ob = automationOrders(a); if (ob) c.append(ob);
    box.append(c);
  }
  return box;
}
// « Lancer maintenant » : un bouton par ordre déclaré dans la configuration ; confirmation si l'ordre en demande une.
function automationOrders(a) {
  if (!canWrite || !a.orders || !a.orders.length) return null;
  const box = el('div', 'actions');
  for (const o of a.orders) {
    const b = el('button', null, '▶ ' + o.label);
    b.title = T('Lancer maintenant : ', 'Run now: ') + o.label + (a.week && a.week.costAvg != null ? T(' — coût moyen d’une passe sur 7 jours : ', ' — average cost of a pass over 7 days: ') + money(a.week.costAvg) : '');
    b.onclick = e => { e.stopPropagation(); runAutomationOrder(a, o); };
    box.append(b);
  }
  return box;
}
async function runAutomationOrder(a, o) {
  if (!canWrite) return;
  if (o.confirm && !confirm(o.confirm)) return;
  say((a.icon ? a.icon + ' ' : '') + a.label + T(' : ', ': ') + o.label + '…');
  try {
    const r = await fetch('/api/automations/order', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ id: a.id, order: o.id }) });
    const j = await r.json().catch(() => ({}));
    say(j.error ? T('refusé : ', 'refused: ') + j.error : j.done ? a.label + T(' : terminé', ': done') + (j.output ? ' — ' + j.output : '') : a.label + T(' : passe lancée — elle apparaît dans son groupe dès que sa session démarre', ': pass started — it shows up in its group as soon as its session starts'));
  } catch { say(T('échec de la demande', 'request failed')); }
  setTimeout(loadAutomations, 3000); setTimeout(loadAutomations, 15000);
}
// Notification d'échec (cloche ou notification Windows ?pass=<automate>:<passe>) : la passe, si elle est du jour.
let pendingPass = new URLSearchParams(location.search).get('pass');
function openPass(ref) {
  passKeep = 'pass:' + ref;
  const it = byKey(passKeep);
  if (!it) { say(T('passe introuvable dans la liste (d’avant minuit ?)', 'pass not found in the list (from before midnight?)')); return; }
  if (launchMode) closeLauncher();
  select(it.key, true);
}
let passFile = null, passFileText = null;      // fichier de la passe affiché dans le détail : '<clé>/<nom>'
async function openPassFile(it, name) {
  const key = it.key + '/' + name;
  if (passFile === key) { passFile = null; passFileText = null; return renderDetail(true); }
  passFile = key; passFileText = name.endsWith('.png') ? null : '…'; renderDetail(true);
  if (name.endsWith('.png')) return;
  try { const r = await fetch(passFileUrl(it, name), { cache:'no-store' }); passFileText = r.ok ? await r.text() : T('(illisible : ' + r.status + ')', '(unreadable: ' + r.status + ')'); } catch { passFileText = T('(illisible)', '(unreadable)'); }
  if (passFile === key) renderDetail(true);
}
const passFileUrl = (it, name) => '/api/automations/file?id=' + encodeURIComponent(it.auto.id) + '&run=' + encodeURIComponent(it.pass.run) + '&name=' + encodeURIComponent(name);
// Détail d'une passe : en-tête (automate, issue, durée, coût), résumé, fichiers, conversation (en direct pendant la passe).
function renderPassDetail(it, force) {
  const main = $('main'), a = it.auto, p = it.pass;
  if (detailKey !== it.key || force) {
    if (detailKey !== it.key) { passFile = null; passFileText = null; }
    detailKey = it.key; main.replaceChildren();
    const head = el('div'); head.id = 'head'; const body = el('div'); body.id = 'body'; main.append(head, body);
    if (p) { const card = el('div', 'rcard ' + it.look); card.append(el('div', 'rtitle', p.summary)); body.append(card); }
    if (p && p.files && p.files.length && a.files) {
      body.append(el('h2', null, T('Fichiers de la passe', 'Pass files')));
      const fl = el('div', 'lf');
      for (const f of p.files) { const b = el('button', 'quick' + (passFile === it.key + '/' + f ? ' on' : ''), f); b.onclick = () => openPassFile(it, f); fl.append(b); }
      body.append(fl);
      if (passFile && passFile.startsWith(it.key + '/')) {
        const name = passFile.slice(it.key.length + 1);
        if (name.endsWith('.png')) { const img = el('img', 'lview'); img.src = passFileUrl(it, name); body.append(img); }
        else if (name.endsWith('.html') && passFileText !== '…') body.append(noteFrame(passFileText || ''));
        else body.append(el('pre', 'lview', passFileText));
      }
    }
    if (it.sessionId) { body.append(el('h2', null, T('Conversation complète', 'Full conversation')), convPane()); applyConvView(it); }
    else body.append(el('div', 'empty', it.running ? T('Session de la passe pas encore repérée.', 'Session of the pass not found yet.') : T('Passe sans session Claude : pas de conversation (voir son résumé et ses fichiers).', 'Pass without a Claude session: no conversation (see its summary and files).')));
  }
  const head = $('head'); head.replaceChildren(); head.className = it.look;
  head.append(el('div', 'dtitle', it.title));
  const chip = el('span', 'chip'); chip.append(el('span', 'dot'), it.running ? T('travaille · depuis ' + ago(Date.now() - it.at), 'working · for ' + ago(Date.now() - it.at)) : (PASS_FR[p.status] || p.status) + T(' · il y a ' + ago(Date.now() - it.since), ' · ' + ago(Date.now() - it.since) + ' ago'));
  if (p && p.dryRun && p.status !== 'dry-run') chip.append(el('span', 'tag cl', T('à blanc', 'dry run')));
  head.append(chip);
  if (it.model) head.append(modelBadge(it.model));
  if (it.tokens) head.append(el('span', 'tok', T('  ·  contexte : ', '  ·  context: ') + it.tokens.toLocaleString(LOCALE) + ' tokens'));
  head.append(el('div', 'meta', [(a.icon ? a.icon + ' ' : '') + a.label, T('lancée le ', 'started ') + new Date(it.at).toLocaleString(LOCALE, { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }),
    p && p.minutes != null ? (p.minutes < 1 ? '< 1 min' : Math.round(p.minutes) + ' min') : null, p && p.costUsd != null ? money(p.costUsd) : null, it.sessionId].filter(Boolean).join(' · ')));
  const actions = el('div', 'actions');
  if (!it.running && it.sessionId && canWrite) {
    const b = el('button', 'primary', T('↻ Reprendre dans un onglet', '↻ Resume in a tab')); b.title = 'claude --resume ' + it.sessionId + T(' — pour l’inspecter ou la questionner ; l’automate ne la reprend pas', ' — to inspect or question it; the automation does not resume it');
    b.onclick = () => openPassConversation(it); actions.append(b);
  }
  const ob = automationOrders(a); if (ob) for (const b of [...ob.children]) actions.append(b);
  head.append(actions);
}
async function openPassConversation(it) {
  if (!confirm(T('Rouvrir la conversation de cette passe (' + it.auto.label + ') dans un nouvel onglet (claude --resume) ?\n\nPour l’inspecter ou la questionner. L’automate ne la reprend pas.', 'Reopen the conversation of this pass (' + it.auto.label + ') in a new tab (claude --resume)?\n\nTo inspect or question it. The automation does not resume it.'))) return;
  try { const x = await post('/api/reopen?id=' + it.sessionId); say(x.error ? T('refusé : ', 'refused: ') + x.error : T('onglet ouvert — la session apparaît dans quelques secondes', 'tab opened — the session shows up in a few seconds')); } catch { say(T('échec de la demande', 'request failed')); }
}
// Enchaînement des phases d'une demande, du premier au dernier run ; au-delà de 5, seules les 5 dernières.
const phaseChain = phases => (phases.length > 5 ? ['…'].concat(phases.slice(-5)) : phases).map(p => RUN_FR[p] || p).join(' → ');
const RUN_FR = { diagnostic:'diagnostic', suite:T('suite', 'follow-up'), dev:'dev', relecture:T('relecture', 'review'), recette:T('recette', 'testing'), reprise:T('reprise', 'rework'), relance:T('relance', 'restart'), reveil:T('réveil', 'wake-up'), go:'go', merge:'merge', production:'production', doc:'doc' };
// ── Run EN COURS : ce qu'il fait maintenant (`r.live`, lu par le serveur dans le transcript du run). runLiveLine est
// PURE (testée) : l'outil en cours et depuis quand, sinon le dernier texte de Claude ; `stale` quand le transcript n'a
// plus bougé depuis RUN_STALE_MS (une commande longue fait battre le transcript toutes les 30 s : le silence est anormal).
const RUN_STALE_MS = 3 * 60000;
const TOOL_ICON = { Bash:'⌨️', PowerShell:'⌨️', Edit:'✏️', Write:'✏️', MultiEdit:'✏️', NotebookEdit:'✏️', Read:'📖', Grep:'🔎', Glob:'🔎', Agent:'🤖', Task:'🤖', WebFetch:'🌐', WebSearch:'🌐', TodoWrite:'📋' };
function runLiveLine(live, now) {
  if (!live) return null;
  const tool = x => (TOOL_ICON[x.name] || '🔧') + ' ' + (x.label && x.label !== x.name ? x.name + ' : ' + x.label : x.name) + (x.since ? T(' · depuis ', ' · for ') + ago(now - x.since) : '');
  const stale = live.lastAt != null && now - live.lastAt > RUN_STALE_MS;
  const text = live.now ? '⏳ ' + tool(live.now) + (live.now.inner ? ' › ' + tool(live.now.inner) : '') : live.text ? '💬 ' + live.text : T('démarre…', 'starting…');
  const todos = live.todos && live.todos.total ? T('📋 ' + live.todos.done + '/' + live.todos.total + ' tâches', '📋 ' + live.todos.done + '/' + live.todos.total + ' tasks') + (live.todos.current ? ' · ' + live.todos.current : '') : null;
  const tools = (live.partial ? '≥ ' : '') + live.tools + T(' outils appelés', ' tool calls');
  const moved = live.lastAt != null ? T('dernier mouvement il y a ' + ago(now - live.lastAt), 'last activity ' + ago(now - live.lastAt) + ' ago') + (stale ? T(' — bloqué ?', ' — stuck?') : '') : null;
  return { text, todos, tools, moved, stale };
}
function runSub(it) {
  const r = it.run, multi = it.runCount > 1;
  const tail = multi ? [phaseChain(it.phases), it.runCount + ' runs' + (it.costTotal != null ? ' · ' + money(it.costTotal) : '')] : [];
  const lv = r.running ? runLiveLine(r.live, Date.now()) : null;
  // Immobile : l'alerte passe EN TÊTE — en fin de ligne, l'ellipse de la liste la mangerait.
  if (lv) return (lv.stale ? ['⚠️ ' + lv.moved] : []).concat([lv.text], tail).join(' · ');
  if (r.running) return [T('travaille' + (r.at ? ' depuis ' + ago(Date.now() - r.at) : ''), 'working' + (r.at ? ' for ' + ago(Date.now() - r.at) : ''))].concat(tail, it.reply ? [lastLine(it.reply)] : []).join(' · ');
  return [it.wait && STAGE_FR[it.wait.stage] ? STAGE_FR[it.wait.stage] : null, it.outcome || null, it.scripted ? T('étape scriptée', 'scripted step') : null]
    .concat(multi ? tail : [r.minutes != null ? Math.round(r.minutes) + ' min' : null, r.costUsd != null ? money(r.costUsd) : null]).filter(Boolean).join(' · ') || '—';
}
// ── Résultat d'un run : ce que le lanceur a CONSTATÉ, lu dans ses propres fichiers — report.json (production : verdict,
// PR, images déployées), verdict.json (recette : verdict, résumé, étapes) et steps.json (journal d'une étape
// SCRIPTÉE, la livraison : pas de session, donc pas de conversation — ses étapes sont tout ce qu'on peut en voir).
// runResult est PURE (testée) : null quand le run n'a aucun des trois (l'en-tête montre déjà son `detail`).
const STEP_ICON = { ok:'✅', ko:'❌', running:'⏳', pending:'○', skipped:'–', warn:'⚠️' };
// Une ligne par étape : { status, icon, title, detail, time }. Deux formes d'étape, un seul rendu — celle du journal
// (status pending|running|ok|ko|skipped, startedAt, endedAt, detail) et celle de la recette (status ok|ko|autre,
// observed). PURE (testée).
function stepRows(steps, now) {
  return (Array.isArray(steps) ? steps : []).filter(s => s && typeof s === 'object' && (s.title || s.key)).map(s => {
    const status = ['ok', 'ko', 'running', 'pending', 'skipped'].includes(s.status) ? s.status : 'warn';
    const a = Date.parse(s.startedAt), b = Date.parse(s.endedAt);
    const time = status === 'running' && a ? T('depuis ', 'for ') + ago(now - a) : a && b && b - a >= 1000 ? ago(b - a) : null;
    // Recette : ce qui a été constaté ne se répète pas sous une étape conforme (la note du run le dit déjà).
    const detail = s.detail != null ? String(s.detail) : s.observed != null && status !== 'ok' ? String(s.observed) : null;
    return { status, icon: STEP_ICON[status], title: String(s.title || s.key), detail: detail || null, time };
  });
}
// Journal d'étapes d'une livraison : où elle en est (titre), ses lignes, et `live` tant qu'il peut encore changer —
// la page le relit alors (un journal muet depuis 3 jours n'est plus relu : son processus est mort). PURE (testée).
function stepsResult(j, now) {
  if (!j || typeof j !== 'object' || !Array.isArray(j.steps)) return null;
  const rows = stepRows(j.steps, now);
  if (!rows.length) return null;
  const done = rows.filter(r => r.status === 'ok').length, cur = rows.find(r => r.status === 'running'), ko = rows.find(r => r.status === 'ko');
  const t = j.outcome === 'in-production' ? ['done', T('🚀 Livrée, en production', '🚀 Delivered, in production')]
    : j.outcome === 'refused' ? ['waiting', T('❌ Livraison non faite', '❌ Delivery not done')]
    : j.outcome === 'merged' ? (ko ? ['waiting', T('⚠️ Mergée — déploiement à regarder', '⚠️ Merged — deployment needs a look')] : ['busy', T('🚚 Mergée — déploiement en cours', '🚚 Merged — deploying')])
    : ['busy', T('🚚 Livraison en cours', '🚚 Delivery in progress')];
  const at = Date.parse(j.updatedAt);
  return { look: t[0], title: t[1] + ' · ' + done + '/' + rows.length + T(' étape', ' step') + (rows.length > 1 ? 's' : '') + (cur ? ' — ' + cur.title : ko ? ' — ' + ko.title : ''),
    lines: [], rows, pr: null,
    live: !['refused', 'in-production'].includes(j.outcome) && rows.some(r => r.status === 'running' || r.status === 'pending') && !(at && now - at > 72 * 3600000) };
}
function runResult(report, verdict, steps, now) {
  if (report && typeof report === 'object' && report.verdict) {
    const live = report.verdict === 'in-production';
    const lines = [[report.mergeSha ? 'merge ' + String(report.mergeSha).slice(0, 10) : null,
      report.files != null ? report.files + T(' fichier', ' file') + (report.files > 1 ? 's' : '') : null,
      Array.isArray(report.sides) && report.sides.length ? report.sides.join(' + ') : null].filter(Boolean).join(' · ')].filter(Boolean);
    for (const d of Array.isArray(report.deployments) ? report.deployments : [])
      lines.push(String(d.name || '?').replace(/-deployment$/, '') + ' ' + (d.tag || '?') + ' · '
        + (d.carries && d.rolledOut ? T('déployé', 'deployed') : d.carries ? T('pas encore déployé partout', 'not deployed everywhere yet') : T('ne porte pas le correctif', 'does not carry the fix')) + (d.reason ? ' (' + d.reason + ')' : ''));
    return { look: live ? 'done' : 'ask', title: live ? T('🚀 En production', '🚀 In production') : T('⏳ Pas encore en production (' + report.verdict + ')', '⏳ Not in production yet (' + report.verdict + ')'), lines,
      pr: Number(report.pr) > 0 ? Number(report.pr) : null };
  }
  if (verdict && typeof verdict === 'object' && verdict.verdict) {
    const v = String(verdict.verdict).toLowerCase(), n = Array.isArray(verdict.steps) ? verdict.steps.length : 0;
    const t = v === 'ok' ? ['done', T('✅ Recette OK', '✅ Testing OK')] : v === 'ko' ? ['waiting', T('❌ Recette KO', '❌ Testing failed')] : ['ask', T('❔ Recette non concluante', '❔ Testing inconclusive')];
    return { look: t[0], title: t[1] + (n ? ' · ' + n + T(' étape', ' step') + (n > 1 ? 's' : '') : ''), lines: verdict.summary ? [String(verdict.summary)] : [], rows: stepRows(verdict.steps, now), pr: null };
  }
  return stepsResult(steps, now);
}
// Carte du résultat : titre, lignes, puis une ligne par étape (statut, titre, durée, détail).
function resultCard(res) {
  const card = el('div', 'rcard ' + res.look); card.id = 'rcard'; card.append(el('div', 'rtitle', res.title));
  for (const l of res.lines) card.append(el('div', 'rline', l));
  for (const s of res.rows || []) {
    const row = el('div', 'rstep ' + s.status), txt = el('div', 'rt');
    txt.append(el('span', null, s.title)); if (s.time) txt.append(el('span', 'rw', ' · ' + s.time));
    if (s.detail) txt.append(el('div', 'rd', s.detail));
    row.append(el('span', 'ri', s.icon), txt); card.append(row);
  }
  return card;
}
// Note ouverte d'office dans le détail d'un run : celle que l'on vient relire — ce qui change pour le métier
// (production), le compte rendu de recette, la note de doc, sinon la note postée sur le ticket. PURE (testée).
function runNote(phase, files) {
  const names = (files || []).map(f => f.name), first = { production:'resolution.html', recette:'recettenote.html', doc:'docnote.html' }[phase];
  return [first, 'devnote.html', 'note.html'].find(n => n && names.includes(n)) || null;
}
// Demande vue de bout en bout (frise des runs) : du premier run à la fin du dernier, dont le temps de travail du
// lanceur (somme des durées de run) — le reste est de l'attente (feu vert, file du lanceur, déploiement). PURE (testée).
function runSpan(runs, now) {
  const rs = (runs || []).map(i => i.run).filter(Boolean);
  if (rs.length < 2) return null;
  const first = rs.reduce((a, b) => (b.at < a.at ? b : a)), last = rs.reduce((a, b) => (b.at > a.at ? b : a));
  const end = Math.max(...rs.map(r => r.running ? now : r.at + Math.round((r.minutes || 0) * 60000)));
  const total = Math.max(0, Math.round((end - first.at) / 60000)), work = Math.min(total, Math.round(rs.reduce((s, r) => s + (r.minutes || 0), 0)));
  return { from: first.phase, fromAt: first.at, to: last.phase, toAt: last.at, totalMin: total, workMin: work, waitMin: total - work, running: rs.some(r => r.running) };
}
const dur = m => m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0');
const hhmm = t => new Date(t).toLocaleTimeString(LOCALE, { hour:'2-digit', minute:'2-digit' });
// report.json / verdict.json d'un run TERMINÉ, lus une fois (ils ne changent plus) ; la page les relit par
// /api/launcher/file, route existante — rien de neuf côté serveur. steps.json fait exception : le journal d'une
// livraison en route est RELU toutes les 5 s. Un run scripté n'est jamais « en cours » pour la page (pas de processus
// Claude) : sans cette relecture, sa carte resterait figée à sa première lecture.
const runAux = new Map();
// Faut-il (re)lire, et quoi ? PURE (testée). c = ce qu'on a déjà lu de ce run ({ at, busy, steps… }), names = ses fichiers.
function runAuxWant(c, names, now) {
  if (!c) return ['report.json', 'verdict.json', 'steps.json'].filter(n => names.includes(n));
  if (c.busy || !names.includes('steps.json') || now - c.at < 5000) return [];
  const res = c.steps ? stepsResult(c.steps, now) : null;
  return !c.steps || (res && res.live) ? ['steps.json'] : [];
}
async function loadRunAux(r) {
  if (r.running) return;
  const c = runAux.get(r.dir), want = runAuxWant(c, (r.files || []).map(f => f.name), Date.now());
  if (!want.length) return;
  const aux = c || {}; aux.busy = true; aux.at = Date.now(); runAux.set(r.dir, aux);
  for (const n of want) { try { aux[n.replace('.json', '')] = JSON.parse(await (await fetch('/api/launcher/file?path=' + encodeURIComponent(r.dir + '\\' + n), { cache:'no-store' })).text()); } catch {} }
  aux.busy = false; aux.at = Date.now();
  if (!detailKey || !detailKey.endsWith('|' + r.dir)) return;
  // Relecture du journal : la carte seule est remplacée — reconstruire le corps effacerait une consigne en cours de frappe.
  const old = c && $('rcard'), res = old && runResult(aux.report, aux.verdict, aux.steps, Date.now());
  if (old && res) old.replaceWith(resultCard(res)); else renderDetail(true);
}
// Note HTML du lanceur rendue (le serveur la sert en text/plain, exprès) : iframe SANS scripts — allow-same-origin
// seulement pour lire sa hauteur ; les liens s'ouvrent dans un nouvel onglet.
function noteFrame(html) {
  const f = el('iframe', 'lnote');
  f.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox'); f.setAttribute('referrerpolicy', 'no-referrer');
  f.srcdoc = '<base target="_blank"><style>body{font:14px/1.5 system-ui,sans-serif;margin:12px 16px;color:#1f1e1c}</style>' + html;
  f.onload = () => { try { f.style.height = Math.min(1200, f.contentDocument.documentElement.scrollHeight + 8) + 'px'; } catch {} };
  return f;
}
let runFile = null, runFileText = null;      // fichier du run affiché dans le détail : 'dir/nom'
async function viewRunFile(it, name) {
  const key = it.run.dir + '/' + name;
  if (runFile === key) { runFile = null; runFileText = null; return renderDetail(true); }
  openRunFile(it, name);
}
// quiet : appelé PENDANT le rendu du détail (note ouverte d'office) — pas de re-rendu immédiat, seulement à la lecture.
async function openRunFile(it, name, quiet) {
  const key = it.run.dir + '/' + name;
  runFile = key; runFileText = name.endsWith('.png') ? null : '…'; if (!quiet) renderDetail(true);
  if (!name.endsWith('.png')) { try { runFileText = await (await fetch('/api/launcher/file?path=' + encodeURIComponent(it.run.dir + '\\' + name), { cache:'no-store' })).text(); } catch { runFileText = T('(illisible)', '(unreadable)'); } if (runFile === key) renderDetail(true); }
}
// Détail d'un run : en-tête (statut, modèle, coût, tours, PR), fichiers du run, conversation (suivie en direct pendant le run).
function renderRunDetail(it, force) {
  const main = $('main'), r = it.run;
  // Clé de détail = demande + run : le corps se reconstruit quand la demande passe au run suivant ou qu'on en choisit
  // un autre dans la frise.
  const dk = it.key + '|' + r.dir;
  // Résultat constaté (report.json / verdict.json) ; sa PR complète celle de la demande quand le lanceur ne la
  // donnait plus (étape scriptée hors attente : pas de `waiting`, donc pas de PR — l'en-tête n'avait aucun lien).
  loadRunAux(r);
  const aux = runAux.get(r.dir) || {}, res = runResult(aux.report, aux.verdict, aux.steps, Date.now());
  if (res && res.pr && !it.pr) it = { ...it, pr: res.pr, prUrl: ui().prUrl ? ui().prUrl + res.pr : null };
  if (detailKey !== dk || force) {
    // Changement de run : sa note s'ouvre d'office (sauf fichier déjà choisi dans ce run).
    if (detailKey !== dk && !(runFile && runFile.startsWith(r.dir + '/'))) { const n = !r.running && runNote(r.phase, r.files); if (n) openRunFile(it, n, true); else { runFile = null; runFileText = null; } }
    detailKey = dk; main.replaceChildren();
    const head = el('div'); head.id = 'head'; const acts = el('div'); acts.id = 'dacts'; const body = el('div'); body.id = 'body'; main.append(head, acts, body);
    if (res) body.append(resultCard(res));
    // Bloc « Piloter » dans le CORPS (reconstruit au changement de run seulement) : la consigne en cours de frappe ne
    // doit pas être effacée par le rafraîchissement de l'en-tête, toutes les 2 s.
    const ob = el('div', 'orders'); ob.id = 'orders'; body.append(ob); renderOrders(it);
    // Frise des runs de la demande (du plus récent au plus ancien) : un clic affiche ce run (fichiers, conversation).
    if (it.runs && it.runs.length > 1) {
      body.append(el('h2', null, T('Runs de HD-' + r.hd, 'Runs of HD-' + r.hd) + ' (' + it.runs.length + (it.costTotal != null ? ' · ' + money(it.costTotal) : '') + ')'));
      const sp = runSpan(it.runs, Date.now());
      if (sp) body.append(el('div', 'rspan', [(RUN_FR[sp.from] || sp.from) + ' ' + hhmm(sp.fromAt) + ' → ' + (RUN_FR[sp.to] || sp.to) + ' ' + hhmm(sp.toAt),
        dur(sp.totalMin) + (sp.running ? T(' jusqu’ici', ' so far') : T(' de bout en bout', ' end to end')), dur(sp.workMin) + T(' de travail du lanceur', ' of launcher work'), dur(sp.waitMin) + T(' d’attente (feu vert, file, déploiement)', ' of waiting (go-ahead, queue, deployment)'),
        it.costTotal != null ? money(it.costTotal) : null].filter(Boolean).join(' · ')));
      const fr = el('div', 'lf runs-hd');
      for (const x of it.runs) {
        const xr = x.run, o = xr.running ? T('en cours', 'running') : x.outcome || '—';
        const b = el('button', 'quick ' + x.look + (xr.dir === r.dir ? ' on' : ''),
          [new Date(xr.at).toLocaleTimeString(LOCALE, { hour:'2-digit', minute:'2-digit' }), RUN_FR[xr.phase] || xr.phase, o,
           xr.minutes != null ? Math.round(xr.minutes) + ' min' : null, xr.costUsd != null ? money(xr.costUsd) : null].filter(Boolean).join(' · '));
        const headDir = (it.runs.find(i => i.run.running) || it.runs[0]).run.dir;     // le run que reprend la ligne
        b.onclick = () => { if (xr.dir === headDir) runPick.delete(it.key); else runPick.set(it.key, xr.dir); runFile = null; renderDetail(true); };
        fr.append(b);
      }
      body.append(fr);
    }
    if (r.files && r.files.length) {
      body.append(el('h2', null, T('Fichiers du run', 'Run files')));
      const fl = el('div', 'lf');
      for (const f of r.files) { const b = el('button', 'quick' + (runFile === r.dir + '/' + f.name ? ' on' : ''), f.name); b.title = Math.max(1, Math.round(f.size / 1024)) + T(' Ko', ' KB'); b.onclick = () => viewRunFile(it, f.name); fl.append(b); }
      body.append(fl);
      if (runFile && runFile.startsWith(r.dir + '/')) {
        const name = runFile.slice(r.dir.length + 1);
        if (name.endsWith('.png')) { const img = el('img', 'lview'); img.src = '/api/launcher/file?path=' + encodeURIComponent(r.dir + '\\' + name); body.append(img); }
        else if (name.endsWith('.html') && runFileText !== '…') body.append(noteFrame(runFileText || ''));
        else body.append(el('pre', 'lview', runFileText));
      }
    }
    if (it.sessionId) { body.append(el('h2', null, T('Conversation complète', 'Full conversation')), convPane()); applyConvView(it); }
    else body.append(el('div', 'empty', it.scripted ? T('Étape scriptée du lanceur : aucune session Claude, donc pas de conversation (voir ses étapes ci-dessus quand elle en écrit, et ses fichiers).', 'Scripted launcher step: no Claude session, so no conversation (see its steps above when it writes some, and its files).') : T('Conversation introuvable : identifiant de session inconnu pour ce run.', 'Conversation not found: unknown session id for this run.')));
  }
  // L'étape de la demande change sans changement de run (ordre pris, livraison démarrée) : le corps n'est pas reconstruit,
  // le bloc « Piloter » doit suivre quand même — sinon « Livrer la PR » reste offert alors que la livraison tourne.
  // Jamais sous les doigts : ni ordre en cours, ni saisie ; un formulaire ouvert ne cède qu'à la livraison.
  { const w = it.wait || deliveringWait(it), stg = w ? w.stage : null, ob = $('orders');
    const sig = stg + '|' + (stg === 'delivering' ? Math.floor(Date.now() / 60000) : '');
    if (ob && orderUi.key === it.key && orderUi.sig !== sig && !orderUi.busy && !ob.contains(document.activeElement) && (!orderUi.open || stg === 'delivering')) {
      const first = orderUi.sig === undefined; orderUi.sig = sig;
      if (!first) { if (stg === 'delivering') orderUi.open = null; renderOrders(it); }
    } }
  const head = $('head'); head.replaceChildren(); head.className = it.look;
  head.append(el('div', 'dtitle', it.title));
  const chip = el('span', 'chip'); chip.append(el('span', 'dot'), (r.running ? T('travaille · depuis ' + ago(Date.now() - r.at), 'working · for ' + ago(Date.now() - r.at)) : (it.outcome || T('terminé', 'done')) + T(' · il y a ' + ago(Date.now() - it.since), ' · ' + ago(Date.now() - it.since) + ' ago')));
  if (it.wait && STAGE_FR[it.wait.stage]) chip.append(el('span', 'tag cl', STAGE_FR[it.wait.stage]));
  head.append(chip);
  if (it.model) head.append(modelBadge(it.model));
  if (it.tokens) head.append(el('span', 'tok', T('  ·  contexte : ', '  ·  context: ') + it.tokens.toLocaleString(LOCALE) + ' tokens'));
  const meta = el('div', 'meta', [T('🤖 lanceur · ', '🤖 launcher · ') + (RUN_FR[r.phase] || r.phase), T('lancé le ', 'started ') + new Date(r.at).toLocaleString(LOCALE, { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }),
    r.minutes != null ? Math.round(r.minutes) + ' min' : null, r.turns ? r.turns + T(' tours', ' turns') : null, r.costUsd != null ? (Math.round(r.costUsd * 100) / 100).toLocaleString(LOCALE) + ' $' : null,
    it.pid ? 'pid ' + it.pid : null, it.sessionId].filter(Boolean).join(' · '));
  const a = prLink(it); if (a) meta.append(' · ', a);
  head.append(meta);
  if (r.detail) head.append(el('div', 'meta', r.detail));
  { const lv = r.running ? runLiveLine(r.live, Date.now()) : null;
    if (lv) {
      const box = el('div', 'runlive' + (lv.stale ? ' stale' : ''));
      box.append(el('div', 'rl-now', lv.text));
      if (lv.todos) box.append(el('div', 'rl-sub', lv.todos));
      if (r.live.now && r.live.text) box.append(el('div', 'rl-sub', '💬 ' + r.live.text));
      box.append(el('div', 'rl-sub', [lv.tools, lv.moved].filter(Boolean).join(' · ')));
      head.append(box);
    } }
  if (it.wait && it.wait.detail) head.append(el('div', 'meta', T('Demande : ', 'Request: ') + it.wait.detail));
  head.append(hdBlock(r.hd));
  actionBar($('dacts'), it, actionsFor(it, actionCtx(it)));
  head.append(el('div', 'banner', runBanner(!!r.running, !!(it.sessionId || r.sessionId))));
}
// La DEMANDE derrière un run (en-tête du détail) : demandeur, date, type, statut, assigné, client, liens Teams et
// de tickets, début de la description — lue par GET /api/launcher/hd (commande de lecture des tickets du lanceur), gardée
// ici par HD (l'en-tête se redessine toutes les 2 s ; le serveur garde 5 min). hdParts est PURE (testée par le .ps1).
const HD_STATUS_FR = { New:T('Nouveau', 'New'), Open:T('Ouvert', 'Open'), InProgress:T('En cours', 'In progress'), Pending:T('En attente', 'Pending'), Waiting:T('En attente', 'Waiting'), Resolved:T('Résolu', 'Resolved'), Closed:T('Fermé', 'Closed') };
const HD_KIND_FR = { Bug:'🐞 Bug', Idee:T('💡 Idée', '💡 Idea') };
const HD_PRIO_FR = { Low:T('basse', 'low'), Medium:T('moyenne', 'medium'), High:T('haute', 'high'), Urgent:T('urgente', 'urgent') };
function hdParts(h) {
  const when = h.createdAt ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(h.createdAt) ? h.createdAt : h.createdAt + 'Z') : null;
  return [
    h.kind ? (HD_KIND_FR[h.kind] || h.kind) : null,
    h.status ? (HD_STATUS_FR[h.status] || h.status) : null,
    h.requester ? T('demandée par ', 'requested by ') + h.requester : null,
    when && !isNaN(when) ? T('le ', 'on ') + when.toLocaleString(LOCALE, { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : null,
    h.domain ? T('domaine ', 'domain ') + h.domain : null,
    h.severity ? T('sévérité ', 'severity ') + h.severity : null,
    h.priority ? T('priorité ', 'priority ') + (HD_PRIO_FR[h.priority] || h.priority) : null,
    h.assignee ? T('assignée à ', 'assigned to ') + h.assignee : null,
    h.clients ? h.clients + (h.clients > 1 ? T(' clients liés', ' linked clients') : T(' client lié', ' linked client')) : null,
  ].filter(Boolean);
}
const hdInfo = {};                              // hd → { at, value } | { at, loading }
function hdBlock(hd) {
  const box = el('div', 'hdreq');
  const c = hdInfo[hd];
  if (!c || (!c.loading && Date.now() - c.at > (c.value.error ? 60000 : 300000))) {
    hdInfo[hd] = { at: Date.now(), loading: true, value: c && c.value };
    fetch('/api/launcher/hd?hd=' + encodeURIComponent(hd), { cache:'no-store' }).then(x => x.json()).catch(() => ({ error: T('serveur injoignable', 'server unreachable') }))
      .then(v => { hdInfo[hd] = { at: Date.now(), value: v }; renderDetail(); });
  }
  const h = hdInfo[hd].value;
  if (!h) { box.append(el('span', 'mute', T('📨 Demande HD-' + hd + ' : lecture…', '📨 Request HD-' + hd + ': loading…'))); return box; }
  if (h.error) { box.append(el('span', 'mute', T('📨 Demande HD-' + hd + ' : ', '📨 Request HD-' + hd + ': ') + h.error)); return box; }
  const line = el('div', 'hdl'); line.append(el('b', null, T('📨 Demande', '📨 Request')), ' · ' + hdParts(h).join(' · '));
  const link = (txt, url) => { const a = el('a', null, txt); a.href = url; a.target = '_blank'; a.rel = 'noopener'; return a; };
  if (ui().ticketUrl) line.append(' · ', link((ui().ticketLabel || 'Ticket') + ' ↗', ui().ticketUrl + h.hd));
  if (h.teamsUrl) line.append(' · ', link('Teams ↗', h.teamsUrl));
  box.append(line);
  if (h.description) { const d = el('div', 'hdd', h.description); d.title = T('Début de la description de la demande', 'Start of the request description'); box.append(d); }
  return box;
}
// Bandeau du détail d'un run : il ne parle de conversation (ni de « Reprendre ») que si le run en a une — une étape
// scriptée (go, merge, production, doc) n'a pas de session Claude.
// Titre du groupe 🤖 : « en cours » et « aujourd'hui » ne comptent QUE les runs du lanceur ; les autres claude -p
// (étiqueteur de sessions, automates divers) sont comptés à part — sinon l'étiqueteur passait pour un run en cours.
function autoTitle(base, rows) {
  const runs = rows.filter(it => it.kind === 'run'), nAuto = rows.length - runs.length;
  const parts = runs.length ? [runs.filter(it => it.run.running).length + T(' en cours', ' running'), runs.length + T(' HD aujourd’hui', ' HD today')] : [];
  if (nAuto) parts.push(nAuto + (nAuto > 1 ? T(' automates', ' automations') : T(' automate', ' automation')));
  return parts.length ? base + ' — ' + parts.join(' · ') : base;
}
function runBanner(running, conv) {
  if (running) return conv ? T('Run du lanceur en cours (claude -p, sans terminal) : on ne lui écrit pas — les ordres se donnent une fois le run terminé. La conversation défile en direct.', 'Launcher run in progress (claude -p, no terminal): you do not write to it — orders are given once the run is over. The conversation scrolls live.')
    : T('Étape scriptée du lanceur en cours : pas de session Claude ni de conversation ; les ordres se donnent une fois l’étape terminée.', 'Scripted launcher step in progress: no Claude session and no conversation; orders are given once the step is over.');
  return conv ? T('Run du lanceur terminé. « Reprendre » rouvre sa conversation dans un onglet, sans rien changer pour le lanceur ; « Piloter » lui donne un ordre.', 'Launcher run over. "Resume" reopens its conversation in a tab, without changing anything for the launcher; "Control" gives it an order.')
    : T('Étape scriptée du lanceur terminée : pas de session Claude ni de conversation à reprendre ; « Piloter » donne un ordre au lanceur.', 'Scripted launcher step over: no Claude session and no conversation to resume; "Control" gives the launcher an order.');
}

// ── Piloter le lanceur depuis le détail d'un run : go + consigne, livrer la PR (confirmation), relire,
// sauter la recette, reprendre, verdict du diagnostic. La page ne fait que TAPER la commande du lanceur
// (POST /api/launcher/order ⇒ la commande du lanceur) : il refait ses gardes et dit son refus, que l'on affiche tel quel.
// runOrders est PURE (testée par sessions-dashboard-tests.ps1) : les gestes PROPOSÉS selon la phase du run et l'étape de
// la demande — un filtre de lisibilité, pas une garde (le lanceur refuse ce qui n'a pas lieu d'être).
function runOrders(phase, stage, pr) {
  // Livraison demandée ou en cours : « Livrer la PR » est déjà pris — le reproposer faisait croire que le clic était perdu.
  if (stage === 'delivering' || stage === 'deploying' || stage === 'in-production') return ['diagnostic', 'suite', 'relance', 'reveil'].includes(phase) ? ['verdict'] : [];
  // Étape de livraison (merge, production, doc) sans attente en cours : la demande est livrée ou en train de l'être —
  // un « go » n'a plus de sens (il proposait de relancer un dev sur un correctif déjà en production).
  if (!stage && ['merge', 'production', 'doc'].includes(phase)) return [];
  const dead = ['dev-abandoned', 'dev-failed', 'pr-closed'].includes(stage);
  // Run `go` : le feu vert est DÉJÀ donné, le correctif est en file jusqu'au run dev. Le reproposer (une carte de
  // validation qui le masquait, une fois répondue, le laissait reparaître) faisait croire qu'il restait à donner.
  // Seul un dev mort (échec, abandon, PR fermée) rend un nouveau go sensé.
  if (phase === 'go' && !dead) return [];
  const prSide = !dead && (stage === 'pr-awaiting-approval' || !!pr || ['dev', 'relecture', 'recette', 'reprise'].includes(phase));
  const o = prSide ? ['merge', 'review', 'recette-skip', 'rework'] : ['go'];
  if (['diagnostic', 'suite', 'relance', 'reveil'].includes(phase)) o.push('verdict');
  return o;
}
// Livraison en cours (étape `delivering`) : ce que le bloc « Piloter » dit À LA PLACE des boutons de livraison. PURE.
// since = moment où le lanceur a enregistré la demande ; mergeAt = début de son run de livraison, s'il a démarré.
function deliveringWait(it) { const w = ((it.runs || []).find(x => x.wait) || {}).wait; return w && w.stage === 'delivering' ? w : null; }
function deliveringNote(stage, since, mergeAt, now) {
  if (stage !== 'delivering') return null;
  const min = t => Math.max(0, Math.round((now - t) / 60000));
  const head = T('🚀 Livraison ', '🚀 Delivery ') + (since ? T('demandée à ' + hhmm(since) + ' — ', 'requested at ' + hhmm(since) + ' — ') : '') + (mergeAt ? T('en cours depuis ' + min(mergeAt) + ' min', 'running for ' + min(mergeAt) + ' min') : T('le lanceur la prend à sa prochaine passe', 'the launcher takes it on its next pass'));
  return head + T('. Rebase sur master, contrôles rejoués (20 à 40 min), puis squash-merge : rien à refaire ici, l’ordre est pris.', '. Rebase on master, checks replayed (20 to 40 min), then squash-merge: nothing to redo here, the order is taken.');
}
// ── Décision de la Tech (carte ✅ posée par le lanceur sous sa dernière note, `techDecision` de son state.json) :
// tranchée ICI comme sur la carte. decisionForm et decideBody sont PURES ; le
// lanceur refait toutes les gardes (ordre « decide ») et pose la note de trace qui ferme la carte.
const DECISION_KIND_FR = { validation:T('✅ Validation Tech', '✅ Tech validation'), cadrage:T('📐 Ouvrir un cadrage', '📐 Open a scoping'), doc:T('📝 Mémoire de domaine', '📝 Domain memory') };
function decisionForm(d) {
  let qs = [];
  try { qs = JSON.parse(d.questionsJson || '[]'); } catch { qs = []; }
  if (!Array.isArray(qs)) qs = [];
  const main = qs.find(q => q && q.id === 'decision') || { question:'', options:[] };
  const opts = q => (q.options || []).map(o => ({ id: String(o.id), label: String(o.label || o.id), recommended: !!o.recommended }));
  return {
    title: DECISION_KIND_FR[d.kind] || T('✅ Décision de la Tech', '✅ Tech decision'),
    question: String(main.question || ''),
    choices: qs.filter(q => q && q.id !== 'decision').map(q => ({ id: String(q.id), header: String(q.header || q.id), question: String(q.question || ''), options: opts(q) })),
    decisions: opts(main).map(o => ({ ...o, needsText: d.kind === 'validation' && o.id === 'non' })),
  };
}
function decideBody(hd, d, decision, picks, text) {
  const f = decisionForm(d);
  const dec = f.decisions.find(x => x.id === decision);
  if (!dec) return { error: T('décision inconnue', 'unknown decision') };
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (dec.needsText && !t) return { error: T('« ' + dec.label + ' » demande un motif : il est dit au demandeur', '"' + dec.label + '" needs a reason: it is told to the requester') };
  const choices = {};
  for (const c of f.choices) { const v = picks && picks[c.id]; if (v && c.options.some(o => o.id === v)) choices[c.id] = v; }
  return { hd: String(hd), order: 'decide', value: decision, choices, text: t };
}
const decisionOf = hd => ((runData && runData.decisions) || []).find(x => String(x.hd) === String(hd)) || null;
let decideUi = { key: null, picks: {}, text: '' };
function renderDecision(box, it, d) {
  const f = decisionForm(d), hd = String(it.run.hd);
  if (decideUi.key !== hd + ':' + d.interaction) {
    decideUi = { key: hd + ':' + d.interaction, picks: {}, text: '' };
    for (const c of f.choices) { const r = c.options.find(o => o.recommended); if (r) decideUi.picks[c.id] = r.id; }
  }
  const card = el('div', 'orderform decision');
  card.append(el('div', null, f.title + T(' — en attente depuis ', ' — waiting for ') + (d.since ? ago(Date.now() - d.since) : '?')));
  if (f.question) card.append(el('div', 'meta', f.question));
  for (const c of f.choices) {
    const line = el('div', 'meta'); line.append(c.header + ' — ' + c.question + ' ');
    const sel = el('select'); sel.append(el('option', null, T('— choisir —', '— choose —'))); sel.firstChild.value = '';
    for (const o of c.options) { const op = el('option', null, o.label + (o.recommended ? T(' (recommandé)', ' (recommended)') : '')); op.value = o.id; if (decideUi.picks[c.id] === o.id) op.selected = true; sel.append(op); }
    sel.onchange = () => { decideUi.picks[c.id] = sel.value; };
    line.append(sel); card.append(line);
  }
  const ta = el('textarea'); ta.value = decideUi.text; ta.maxLength = 2000; ta.rows = 2;
  ta.placeholder = T('Consigne (Lancer), motif (Ne pas faire : obligatoire, dit au demandeur) ou texte « Autre »', 'Instruction (Start), reason (Do not do: required, told to the requester) or "Other" text');
  ta.oninput = () => { decideUi.text = ta.value; };
  card.append(ta);
  const a = el('div', 'actions');
  for (const dec of f.decisions) {
    const b = el('button', dec.recommended ? 'primary' : null, dec.label); b.disabled = orderUi.busy;
    b.onclick = () => { const body = decideBody(hd, d, dec.id, decideUi.picks, decideUi.text); if (body.error) { orderUi.result = { ok: false, text: '⛔ ' + body.error }; renderOrders(it); return; } sendOrder(it, body); };
    a.append(b);
  }
  card.append(a, el('div', 'hint', T('Ordre « decide ' + hd + ' … » — rejouée comme un clic sur la carte ; une note visible le dit au demandeur et ferme la carte.', 'Order "decide ' + hd + ' …" — replayed as a click on the card; a visible note tells the requester and closes the card.')));
  box.append(card);
}
// ── Cartes de questions du lanceur (module « launcher », clé cardsApi — server/src/cards.ts) : ce que l'orchestrateur
// demande à l'opérateur sous une de ses notes se lit et se RÉPOND ici, comme le dialogue d'une session : options en
// boutons avec leur description, recommandée en premier, « Autre » en texte libre. Toutes les questions de la carte
// sont visibles ; rien ne part avant « Envoyer les réponses ». La réponse passe par la commande des cartes : dans le
// ticket, c'est un clic de l'opérateur sur la carte. cardRuns, withCards, cardForm et cardAnswers sont PURES
// (testées par server/test/page-cards.test.ts).
const CARD_FR = { arbitrage:T('⚖️ Question pour toi', '⚖️ Question for you'), question:T('❓ Question pour toi', '❓ Question for you'), validation:T('✅ Validation — lancer le développement ?', '✅ Validation — start the development?'), cadrage:T('📐 Ouvrir un cadrage ?', '📐 Open a scoping?'), doc:T('📝 Mémoire de domaine', '📝 Domain memory') };
// Le DERNIER run d'une demande dont une carte attend, quand il est antérieur à `since` (minuit) : la liste ne garde
// que les runs du jour, et la carte se traite depuis le détail d'un run.
function cardRuns(runs, cards, since) {
  const hds = new Set((cards || []).map(c => String(c.hd))), latest = new Map();
  for (const r of runs || []) { const k = String(r.hd); if (hds.has(k) && (!latest.has(k) || latest.get(k).at < r.at)) latest.set(k, r); }
  return [...latest.values()].filter(r => !r.running && !(r.at >= since));
}
// Éléments de la liste (un par demande) → les mêmes, avec leurs cartes ; une demande qui a une carte et ne travaille
// pas « attend ta décision » (couleur ask, groupe « À traiter »).
function withCards(items, cards) {
  const by = new Map();
  for (const c of cards || []) { const k = String(c.hd); if (!by.has(k)) by.set(k, []); by.get(k).push(c); }
  return (items || []).map(it => by.has(String(it.run.hd)) ? { ...it, cards: by.get(String(it.run.hd)), look: it.run.running ? it.look : 'ask' } : it);
}
function cardForm(card) {
  const qs = Array.isArray(card && card.questions) ? card.questions.filter(q => q && q.id != null) : [];
  return {
    id: String(card.id), title: CARD_FR[card.flavor] || CARD_FR[card.kind] || T('Question pour toi', 'Question for you'), neighbours: Number(card.neighbours) || 0,
    questions: qs.map(q => {
      const options = (Array.isArray(q.options) ? q.options : []).map(o => ({ id: String(o.id), label: String(o.label || o.id), description: String(o.description || ''), recommended: !!o.recommended }));
      options.sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0));
      return { id: String(q.id), header: String(q.header || q.id), question: String(q.question || ''), multi: !!q.multiSelect, open: !options.length, options,
        required: card.kind === 'validation' && String(q.id) === 'decision' };
    }),
  };
}
// Ce qui part : { answers } ou { error } ; `missing` = les questions laissées sans réponse (la carte se ferme quand même).
function cardAnswers(card, picks, others) {
  const f = cardForm(card), answers = [], missing = [];
  for (const q of f.questions) {
    const known = new Set(q.options.map(o => o.id));
    let selected = ((picks && picks[q.id]) || []).filter(v => known.has(v));
    if (!q.multi) selected = selected.slice(0, 1);
    const other = String((others && others[q.id]) || '').trim();
    if (other.length > 2000) return { error: T('« ' + q.header + ' » : 2 000 caractères au plus', '"' + q.header + '": 2,000 characters at most') };
    if (selected.length || other) answers.push({ questionId: q.id, selected, other: other || null }); else missing.push(q.header);
  }
  if (!answers.length) return { error: T('Réponds à au moins une question', 'Answer at least one question') };
  const dec = f.questions.find(q => q.required);
  if (dec) {
    const a = answers.find(x => x.questionId === dec.id);
    if (!a || a.selected.length !== 1) return { error: T('Choisis la décision : ', 'Choose the decision: ') + dec.options.map(o => o.label).join(' / ') };
    if (card.flavor === 'validation' && a.selected[0] === 'non' && !a.other) return { error: T('« Ne pas faire » demande un motif : il est dit au demandeur', 'Declining needs a reason: it is told to the requester') };
  }
  return { answers, missing };
}
const cardsOn = () => !!(runData && runData.cardsToken === 'ok');
const cardsFor = hd => cardsOn() ? (runData.cards || []).filter(c => String(c.hd) === String(hd)) : [];
let cardUi = { key: null, picks: {}, others: {}, busy: false };
// Carte de validation répondue ICI : le lanceur met le correctif en file, mais le run `go` n'apparaît qu'à sa passe
// suivante. D'ici là, le run affiché (le diagnostic) reproposait « Feu vert ». On retient, par demande, le dernier run
// au moment de la réponse ; tant que c'est toujours lui, pas de go. Un nouveau run lève la retenue. PURE (testée).
const goHeld = new Map();
function goHeldFor(held, hd, headDir) { return !!headDir && held.get(String(hd)) === headDir; }
const headDirOf = it => ((it.runs || []).find(i => i.run.running) || (it.runs || [])[0] || it).run.dir;
let cardFresh = null;   // demande dont les cartes ont été relues à l'instant pour l'affichage
// Avant de proposer une carte, la relire dans le ticket : elle a pu être répondue ou remplacée depuis le dernier relevé.
async function refreshCards(it, hd) {
  if (cardFresh === hd) return;
  cardFresh = hd;
  try {
    const r = await (await fetch('/api/launcher/cards?hd=' + encodeURIComponent(hd), { cache:'no-store' })).json();
    if (!runData || !Array.isArray(r.cards)) return;
    const fresh = r.cards.map(c => ({ hd, title: r.title || null, ...c }));
    const before = JSON.stringify(cardsFor(hd).map(c => c.id));
    runData.cards = (runData.cards || []).filter(c => String(c.hd) !== hd).concat(fresh);
    if (before !== JSON.stringify(fresh.map(c => c.id))) { renderList(); if (orderUi.key === it.key) renderOrders(it); }
  } catch {}
}
function renderCard(box, it, card) {
  const f = cardForm(card), hd = String(it.run.hd), key = hd + ':' + f.id;
  if (cardUi.key !== key) cardUi = { key, picks: {}, others: {}, busy: false };
  const c = el('div', 'dlg qcard');
  const since = card.postedAt ? Date.parse(String(card.postedAt).replace(/Z?$/, 'Z')) : 0;
  c.append(el('div', 'tabs', f.title + (card.addressee ? ' · ' + card.addressee : '') + (since ? T(' · posée il y a ' + ago(Date.now() - since), ' · asked ' + ago(Date.now() - since) + ' ago') : '')));
  for (const q of f.questions) {
    const blk = el('div', 'qblock');
    blk.append(el('div', 'q', q.header + ' — ' + q.question));
    if (q.options.length) {
      const os = el('div', 'opts');
      for (const o of q.options) {
        const on = (cardUi.picks[q.id] || []).includes(o.id);
        const b = el('button', 'opt' + (on ? ' sel' : '')); b.type = 'button'; b.disabled = cardUi.busy;
        b.append(el('span', 'n', on ? '✔' : (q.options.indexOf(o) + 1) + '.'), el('span', null, o.label + (o.recommended ? T(' (recommandé)', ' (recommended)') : '')));
        if (o.description) b.append(el('span', 'd', o.description));
        b.onclick = () => {
          const cur = cardUi.picks[q.id] || [];
          cardUi.picks[q.id] = on ? cur.filter(v => v !== o.id) : q.multi ? cur.concat(o.id) : [o.id];
          orderUi.result = null; renderOrders(it);
        };
        os.append(b);
      }
      blk.append(os);
      if (q.multi) blk.append(el('div', 'hint', T('Plusieurs réponses possibles.', 'Several answers allowed.')));
    }
    const row = el('div', 'row'); const ta = el('textarea'); ta.rows = q.open ? 2 : 1; ta.maxLength = 2000; ta.value = cardUi.others[q.id] || ''; ta.disabled = cardUi.busy;
    ta.placeholder = q.open ? T('Ta réponse…', 'Your answer…') : q.required ? T('Consigne pour le développement (Lancer), ou motif (Ne pas faire : obligatoire, dit au demandeur)', 'Instruction for the development (Start), or reason (Do not do: required, told to the requester)') : T('Autre réponse, ou une précision (facultatif)', 'Other answer, or a detail (optional)');
    ta.oninput = () => { cardUi.others[q.id] = ta.value; };
    row.append(ta); blk.append(row);
    c.append(blk);
  }
  const a = el('div', 'row');
  const go = el('button', 'primary', T('Envoyer les réponses', 'Send the answers')); go.disabled = cardUi.busy || !canWrite;
  go.onclick = () => sendCard(it, card);
  a.append(go); c.append(a);
  c.append(el('div', 'hint', T('La réponse part dans le ticket sous ton nom, comme un clic sur la carte, et la carte se ferme : une question laissée vide reste sans réponse.', 'The answer goes into the ticket under your name, like a click on the card, and the card closes: a question left empty stays unanswered.')
    + (f.neighbours ? ' ' + T(plural(f.neighbours, 'autre carte reste ouverte', 'autres cartes restent ouvertes') + ' sous la même note.', plural(f.neighbours, 'other card stays open', 'other cards stay open') + ' under the same note.') : '')));
  box.append(c);
}
// Le message après « Envoyer les réponses » — PURE. L'orchestrateur prévenu dit ce qu'il a fait de la réponse
// (`launcher` : travail mis en file, suite signalée…) ; une commande qui ne le dit pas garde la phrase d'avant.
function cardAnsweredText(hd, missing, j) {
  const said = j && typeof j.launcher === 'string' && j.launcher.trim() ? j.launcher.trim() : '';
  return T('✅ Réponse enregistrée dans HD-' + hd, '✅ Answer saved in HD-' + hd) + (missing.length ? T(' — sans réponse : ', ' — unanswered: ') + missing.join(', ') : '') + '. '
    + (said ? said.charAt(0).toUpperCase() + said.slice(1) + (/[.!?]$/.test(said) ? '' : '.') : T('Le lanceur la lit à sa prochaine passe.', 'The launcher reads it on its next pass.'));
}
async function sendCard(it, card) {
  if (!canWrite || cardUi.busy) return;
  const hd = String(it.run.hd), key = it.key;
  const body = cardAnswers(card, cardUi.picks, cardUi.others);
  if (body.error) { orderUi.result = { ok: false, text: '⛔ ' + body.error }; renderOrders(it); return; }
  cardUi.busy = true; orderUi.result = null; renderOrders(it);
  let res, done = false;
  try {
    const r = await fetch('/api/launcher/answer', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ hd, card: String(card.id), answers: body.answers }) });
    const j = await r.json().catch(() => ({}));
    done = !!(r.ok && (j.ok === true || j.gone));
    res = r.ok && j.ok === true ? { ok: true, text: cardAnsweredText(hd, body.missing, j) }
      : { ok: false, text: '⛔ ' + (j.error || T('réponse refusée (' + r.status + ')', 'answer refused (' + r.status + ')')) };
  } catch { res = { ok: false, text: T('⛔ serveur injoignable', '⛔ server unreachable') }; }
  cardUi.busy = false;
  if (done && card.kind === 'validation') goHeld.set(hd, headDirOf(it));
  if (done && runData) { runData.cards = (runData.cards || []).filter(c => !(String(c.hd) === hd && String(c.id) === String(card.id))); cardUi = { key: null, picks: {}, others: {}, busy: false }; renderList(); }
  say(res.text.split('\n')[0]);
  if (orderUi.key !== key) return;
  orderUi.result = res; renderOrders(it); setTimeout(loadRuns, 3000);
}
const ORDER_FR = { go:T('▶ Feu vert (go)', '▶ Go-ahead (go)'), merge:T('🚀 Livrer la PR', '🚀 Ship the PR'), review:T('🔎 Relire la PR', '🔎 Review the PR'), 'recette-skip':T('⏭ Sauter la recette', '⏭ Skip testing'), rework:T('🔁 Reprendre la PR', '🔁 Rework the PR'),
  adopt:T('🔎 Relire les commits ajoutés, puis livrer', '🔎 Review the added commits, then ship'), retry:T('↻ Relancer la livraison', '↻ Restart the delivery'), session:T('🧑‍💻 Reprendre en session', '🧑‍💻 Resume in a session') };
// Livraison refusée (lot 1 des livraisons refusées) : la NATURE du refus, publiée par le
// lanceur (stages.json → waiting.refusalKind), remplace « Livrer la PR » par la suite qui a un sens. Commits ajoutés après
// les contrôles ⇒ les relire ici, puis livrer CE sha (merge --adopt-head) ; panne technique ⇒ relancer. Conflit,
// doublon, autre refus (lot 2) : « Livrer la PR » serait refusé à l'identique ⇒ « Reprendre en session » (formulaire
// Nouvelle session prérempli) ; offert aussi en repli après les deux premiers. PURE (testée par le .ps1).
function deliveryOrders(list, refusalKind) {
  if (!refusalKind || !list.includes('merge')) return list;
  if (refusalKind === 'head-changed') return [...list.map(o => o === 'merge' ? 'adopt' : o), 'session'];
  if (refusalKind === 'technical') return [...list.map(o => o === 'merge' ? 'retry' : o), 'session'];
  return list.map(o => o === 'merge' ? 'session' : o);
}
// Premier message de la session de reprise (PURE, testée par le .ps1) : la PR, ce que le lanceur a dit, et la règle —
// rien n'est mergé sans le go de l'humain. Une session qui livrerait seule ferait sauter la relecture que le refus garde.
const RESUME_WHAT = { conflict:'résous le conflit avec la branche principale', duplicate:'vérifie si elle double un travail déjà livré ou ouvert (à fermer) ou si elle le complète (à livrer)',
  'head-changed':'relis les commits ajoutés après les contrôles du lanceur', technical:'comprends la panne de la livraison' };
function resumePrompt(hd, pr, kind, reason) {
  const why = String(reason || '').replace(/^livraison refusée — /, '').replace(/\s+/g, ' ').trim();
  return ['La livraison automatique de la PR #' + pr + ' (demande HD-' + hd + ') a été refusée par le lanceur' + (why ? ' : « ' + why.slice(0, 500) + ' »' : '') + '.',
    'Reprends-la : pars de la branche de la PR à jour dans un worktree neuf, ' + (RESUME_WHAT[kind] || 'comprends ce qui bloque') + ', rebase sur la branche principale juste avant, rejoue build et tests.',
    'Ne merge rien sans mon go : montre-moi d’abord ce que tu as changé et le résultat des contrôles.'].join('\n\n');
}
// Ce que dit l'en-tête du bloc de relecture (PURE, testée par le .ps1) : commits ajoutés, ou PR réécrite (rebase,
// force-push) dont il faut tout relire, ou rien à relire (la PR porte de nouveau la tête contrôlée).
function diffHeadline(d) {
  if (!d || d.error) return '⛔ ' + ((d && d.error) || T('diff illisible', 'unreadable diff'));
  if (d.merged || d.state === 'closed') return T('La PR n’est plus ouverte (' + (d.merged ? 'mergée' : 'fermée') + ') : rien à livrer.', 'The PR is no longer open (' + (d.merged ? 'merged' : 'closed') + '): nothing to ship.');
  if (!d.changed) return T('La PR porte de nouveau le commit contrôlé par le lanceur : rien à relire, la livraison simple suffit.', 'The PR carries the commit checked by the launcher again: nothing to review, a plain delivery is enough.');
  const n = (d.commits || []).length, files = (d.files || []).length;
  const what = n + ' commit' + (n > 1 ? 's' : '') + ' · ' + files + T(' fichier', ' file') + (files > 1 ? 's' : '');
  return d.rewritten ? T('⚠️ La PR a été réécrite (rebase ou force-push) depuis les contrôles : c’est TOUTE la PR qui est à relire — ' + what + '.', '⚠️ The PR was rewritten (rebase or force-push) since the checks: the WHOLE PR needs a review — ' + what + '.')
    : T('Arrivé sur la PR après les contrôles du lanceur, lu par personne : ' + what + '.', 'Added to the PR after the launcher checks, read by nobody: ' + what + '.');
}
let orderUi = { key: null, open: null, text: '', busy: false, result: null, diff: null };
function renderOrders(it) {
  const box = $('orders'); if (!box) return;
  const r = it.run, hd = String(r.hd);
  if (orderUi.key !== it.key) orderUi = { key: it.key, open: null, text: '', busy: false, result: null, diff: null };
  box.replaceChildren();
  // L'attente est portée par le DERNIER run de la demande : un run plus ancien choisi dans la frise la lit chez lui —
  // pour la livraison seulement (ses boutons y seraient tout aussi trompeurs).
  const wait = it.wait || deliveringWait(it);
  const stage = wait ? wait.stage : null, pr = it.pr;
  if (stage === 'delivering') {
    const mr = (it.runs || []).map(x => x.run).filter(x => x.phase === 'merge' && (!wait.since || x.at >= wait.since - 60000)).sort((a, b) => b.at - a.at)[0];
    const note = el('div', 'banner delivering', deliveringNote(stage, wait.since, mr ? mr.at : null, Date.now()));
    if (mr && mr.dir !== r.dir) { const b = el('button', 'quick', T('Voir le run de livraison', 'See the delivery run')); b.onclick = () => { const head = (it.runs.find(i => i.run.running) || it.runs[0]).run.dir; if (mr.dir === head) runPick.delete(it.key); else runPick.set(it.key, mr.dir); runFile = null; renderDetail(true); }; note.append(' ', b); }
    box.append(note);
  }
  if (r.running) return;
  // Cartes de questions (jeton rangé) : elles portent AUSSI la décision ✅ — l'ancien formulaire ne sert plus que sans elles.
  const cards = cardsFor(hd);
  if (cards.length) refreshCards(it, hd);
  const dec = cardsOn() ? null : decisionOf(hd);
  // Une décision en attente remplace le go nu : « Lancer » de la carte part avec ses choix et laisse la trace.
  const list = deliveryOrders(runOrders(r.phase, stage, pr).filter(o => !((dec || cards.some(c => c.kind === 'validation') || goHeldFor(goHeld, hd, headDirOf(it))) && o === 'go')), wait ? wait.refusalKind : null);
  const noToken = !!(runData && runData.cardsToken === 'absent' && (r.files || []).some(f => f.name === 'questions.json'));
  if (!list.length && !dec && !cards.length && !noToken) return;
  box.append(el('h2', null, T('Piloter HD-' + hd, 'Control HD-' + hd)));
  for (const c of cards) renderCard(box, it, c);
  if (noToken) box.append(el('div', 'meta', T('Ce run a posé des questions : pour y répondre ici, range le jeton des cartes sur ce poste. En attendant, elles se traitent dans le ticket.', 'This run asked questions: to answer them here, store the cards token on this machine. Meanwhile, they are handled in the ticket.')));
  if (dec) renderDecision(box, it, dec);
  const row = el('div', 'actions');
  for (const o of list) {
    if (o === 'verdict') {
      row.append(el('span', 'meta', T('Verdict du diagnostic :', 'Diagnosis verdict:')));
      for (const v of ['ok', 'partiel', 'faux']) { const b = el('button', orderUi.open === 'verdict:' + v ? 'primary' : null, T(v, { ok:'ok', partiel:'partial', faux:'wrong' }[v])); b.disabled = orderUi.busy; b.onclick = () => { orderUi.open = orderUi.open === 'verdict:' + v ? null : 'verdict:' + v; renderOrders(it); }; row.append(b); }
      continue;
    }
    const b = el('button', orderUi.open === o ? 'primary' : null, ORDER_FR[o]); b.disabled = orderUi.busy;
    b.onclick = () => o === 'session' ? openNew(null, { title: 'Reprendre la livraison de HD-' + hd + (pr ? ' (PR #' + pr + ')' : ''),
        prompt: resumePrompt(hd, pr || '?', it.wait && it.wait.refusalKind, it.wait && it.wait.detail), tags: [{ axis: 'fonction', v: 'livraison-refusee' }] })
      : o === 'adopt' ? toggleAdopt(it)
      : (o === 'go' || o === 'merge' || o === 'retry') ? (orderUi.open = orderUi.open === o ? null : o, renderOrders(it)) : sendOrder(it, { order: o });
    row.append(b);
  }
  box.append(row);
  const open = orderUi.open;
  if (open === 'go' || (open && open.startsWith('verdict:'))) {
    const f = el('div', 'orderform');
    const ta = el('textarea'); ta.value = orderUi.text; ta.maxLength = 2000; ta.rows = 3;
    ta.placeholder = open === 'go' ? T('Consigne pour la session de développement (facultatif) — ex. « charge les agents à part, comme dans AppointmentEndpointSetup »', 'Instruction for the development session (optional) — e.g. "load the agents separately, as in AppointmentEndpointSetup"') : T('Commentaire (facultatif)', 'Comment (optional)');
    ta.oninput = () => { orderUi.text = ta.value; };
    const v = open.startsWith('verdict:') ? open.slice(8) : null;
    const go = el('button', 'primary', v ? T('Noter « ' + v + ' »', 'Record "' + { ok:'ok', partiel:'partial', faux:'wrong' }[v] + '"') : T('Envoyer le feu vert', 'Send the go-ahead')); go.disabled = orderUi.busy;
    go.onclick = () => sendOrder(it, v ? { order: 'verdict', value: v, text: orderUi.text } : { order: 'go', text: orderUi.text });
    const cancel = el('button', null, T('Annuler', 'Cancel')); cancel.onclick = () => { orderUi.open = null; renderOrders(it); };
    const a = el('div', 'actions'); a.append(go, cancel);
    f.append(ta, a, el('div', 'hint', v ? T('Ordre « verdict ' + hd + ' ' + v + ' » — noté à la prochaine passe.', 'Order "verdict ' + hd + ' ' + v + '" — recorded on the next pass.') : T('Ordre « go ' + hd + ' » — correctif en file, toujours en PR à relire (jamais de merge automatique).', 'Order "go ' + hd + '" — fix queued, always as a PR to review (never an automatic merge).')));
    box.append(f);
  } else if (open === 'adopt') {
    box.append(adoptForm(it, hd, pr));
  } else if (open === 'merge' || open === 'retry') {
    const f = el('div', 'orderform confirm');
    if (open === 'retry') f.append(el('div', 'meta', T('La livraison précédente a échoué pour une raison technique, sans rapport avec la PR : ', 'The previous delivery failed for a technical reason, unrelated to the PR: ') + ((it.wait && it.wait.detail) || '') ));
    f.append(el('div', null, T('🚀 Livrer ' + (pr ? 'la PR #' + pr : 'la PR du lanceur') + ' de HD-' + hd + ' : rebase sur master, contrôles rejoués (20 à 40 min), puis squash-merge — elle part en PRODUCTION.', '🚀 Ship ' + (pr ? 'PR #' + pr : 'the launcher PR') + ' of HD-' + hd + ': rebase on master, checks replayed (20 to 40 min), then squash-merge — it goes to PRODUCTION.')));
    const link = prLink(it); if (link) { const m = el('div', 'meta'); m.append(T('Relire avant : ', 'Review first: '), link); f.append(m); }
    const ok = el('button', 'primary', T('Confirmer la livraison', 'Confirm the delivery')); ok.disabled = orderUi.busy; ok.onclick = () => sendOrder(it, { order: 'merge', confirm: true });
    const cancel = el('button', null, T('Annuler', 'Cancel')); cancel.onclick = () => { orderUi.open = null; renderOrders(it); };
    const a = el('div', 'actions'); a.append(ok, cancel); f.append(a);
    box.append(f);
  }
  if (cardUi.busy) box.append(el('div', 'meta', T('Réponse en cours d’envoi…', 'Sending the answer…')));
  if (orderUi.busy) box.append(el('div', 'meta', T('Ordre en cours de transmission au lanceur…', 'Sending the order to the launcher…')));
  else if (orderUi.result) box.append(el('pre', 'orderres ' + (orderUi.result.ok ? 'ok' : 'ko'), orderUi.result.text));
}
// « J'ai relu, livrer » : le diff est relu à chaque ouverture (jamais un cache) — le sha envoyé est celui affiché.
async function toggleAdopt(it) {
  if (orderUi.open === 'adopt') { orderUi.open = null; renderOrders(it); return; }
  const key = it.key; orderUi.open = 'adopt'; orderUi.diff = { loading: true }; renderOrders(it);
  let d;
  try { const r = await fetch('/api/launcher/delivery-diff?hd=' + encodeURIComponent(String(it.run.hd))); d = await r.json().catch(() => ({ error: T('réponse illisible (' + r.status + ')', 'unreadable answer (' + r.status + ')') })); }
  catch { d = { error: T('lanceur injoignable', 'launcher unreachable') }; }
  if (orderUi.key !== key || orderUi.open !== 'adopt') return;
  orderUi.diff = d; renderOrders(it);
}
function adoptForm(it, hd, pr) {
  const f = el('div', 'orderform confirm adopt'), d = orderUi.diff || {};
  if (d.loading) { f.append(el('div', 'meta', T('Lecture du diff auprès du lanceur…', 'Reading the diff from the launcher…'))); return f; }
  f.append(el('div', null, diffHeadline(d)));
  if (!d.error && d.changed) {
    const ul = el('ul', 'commits');
    for (const c of d.commits || []) {
      const li = el('li'); li.append(el('code', null, String(c.sha || '').slice(0, 10)), ' ' + (c.title || ''), el('span', 'meta', '  ' + [c.author, c.date ? new Date(c.date).toLocaleString(LOCALE, { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : null].filter(Boolean).join(' · ')));
      ul.append(li);
    }
    f.append(ul);
    for (const x of d.files || []) {
      const det = el('details', 'difffile'), sum = el('summary');
      sum.append(el('code', null, x.path || '?'), el('span', 'meta', '  ' + (x.status || '') + '  +' + (x.additions ?? 0) + ' −' + (x.deletions ?? 0)));
      det.append(sum);
      const pre = el('pre', 'diff');
      for (const line of String(x.patch || '').split('\n')) pre.append(el('span', line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : null, line + '\n'));
      if (x.patchTruncated || !x.patch) pre.append(el('span', 'hunk', x.patch ? T('… (tronqué — voir la PR)', '… (truncated — see the PR)') : T('(pas de diff texte : binaire, renommage ou trop gros)', '(no text diff: binary, rename or too large)')));
      det.append(pre); f.append(det);
    }
    if (d.truncated) f.append(el('div', 'meta', T('⚠️ Diff tronqué : la suite est sur la PR.', '⚠️ Diff truncated: the rest is on the PR.')));
  }
  const link = prLink(it); if (link) { const m = el('div', 'meta'); m.append(T('Sur GitHub : ', 'On GitHub: '), link); f.append(m); }
  const a = el('div', 'actions');
  if (!d.error && d.changed && !d.merged && d.state !== 'closed' && /^[0-9a-f]{40}$/.test(d.prHead || '')) {
    const ok = el('button', 'primary', T('✅ J’ai relu, livrer', '✅ Reviewed, ship')); ok.disabled = orderUi.busy;
    ok.onclick = () => sendOrder(it, { order: 'merge', confirm: true, adoptHead: d.prHead });
    a.append(ok);
  } else if (!d.error && !d.changed && !d.merged && d.state !== 'closed') {
    const ok = el('button', 'primary', T('🚀 Livrer', '🚀 Ship')); ok.disabled = orderUi.busy; ok.onclick = () => sendOrder(it, { order: 'merge', confirm: true }); a.append(ok);
  }
  const again = el('button', null, T('↻ Relire le diff', '↻ Review the diff again')); again.onclick = () => { orderUi.open = null; toggleAdopt(it); };
  const cancel = el('button', null, T('Annuler', 'Cancel')); cancel.onclick = () => { orderUi.open = null; renderOrders(it); };
  a.append(again, cancel); f.append(a);
  f.append(el('div', 'hint', T('Ordre « merge ' + hd + ' --adopt-head ' + (d.prHead ? String(d.prHead).slice(0, 10) + '…' : '<sha>') + ' »'
    + ' — seul ce commit est adopté : si la PR bouge encore, nouveau refus avec le nouveau diff. Rebase, contrôles rejoués (20 à 40 min), puis squash-merge en PRODUCTION.', 'Order "merge ' + hd + ' --adopt-head ' + (d.prHead ? String(d.prHead).slice(0, 10) + '…' : '<sha>') + '"' + ' — only this commit is adopted: if the PR moves again, a new refusal with the new diff. Rebase, checks replayed (20 to 40 min), then squash-merge to PRODUCTION.')));
  return f;
}
async function sendOrder(it, o) {
  if (!canWrite || orderUi.busy) return;
  const key = it.key; orderUi.busy = true; orderUi.result = null; renderOrders(it);
  let res;
  try {
    const r = await fetch('/api/launcher/order', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ hd: String(it.run.hd), ...o }) });
    const j = await r.json().catch(() => ({}));
    res = !r.ok || j.error ? { ok: false, text: '⛔ ' + (j.error || T('ordre refusé (' + r.status + ')', 'order refused (' + r.status + ')')) } : { ok: true, text: '✅ ' + (j.message || T('ordre transmis', 'order sent')) };
  } catch { res = { ok: false, text: T('⛔ lanceur injoignable', '⛔ launcher unreachable') }; }
  if (orderUi.key !== key) return;
  orderUi.busy = false; orderUi.result = res; if (res.ok) { orderUi.open = null; orderUi.text = ''; }
  say(res.text.split('\n')[0]);
  renderOrders(it); setTimeout(loadRuns, 3000);
}

// ── Après un redémarrage de Windows : sessions qui étaient ouvertes, à rouvrir d'un coup ──
const rebootPick = new Map();       // sessionId -> coché ?
async function reopenMany(ids) {
  if (!ids.length) return say(T('aucune session cochée', 'no session ticked'));
  say(T('réouverture de ' + plural(ids.length, 'session', 'sessions') + '…', 'reopening ' + plural(ids.length, 'session', 'sessions') + '…'));
  try {
    const r = await (await fetch('/api/reopen-many', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ ids }) })).json();
    say(r.error ? T('refusé : ', 'refused: ') + r.error : T(plural(r.opened, 'onglet ouvert', 'onglets ouverts') + (r.skipped ? ' (' + r.skipped + ' ignorée(s))' : '') + ' — les sessions réapparaissent dans quelques secondes', plural(r.opened, 'tab opened', 'tabs opened') + (r.skipped ? ' (' + r.skipped + ' skipped)' : '') + ' — the sessions reappear in a few seconds'));
  } catch { say(T('échec de la demande', 'request failed')); }
  tick();
}
// SANTÉ DU RELAIS d'accès distant (Tailscale) : le serveur PRINCIPAL la donne dans l'état (`server.relay`). En local seulement
// — à distance, la page n'arrive que si le relais marche. Un clic le relance : relais redémarré s'il est arrêté,
// identité Tailscale et `tailscale serve` relus, sans redémarrer le serveur.
let relayBusy = false;
function relayTitle(r) {
  if (r.ok) return T('Accès distant prêt', 'Remote access ready') + (r.url ? ' : ' + r.url : '') + '\n' + T('Clic : revérifier', 'Click: check again');
  return T('Accès distant coupé', 'Remote access down') + ' :\n· ' + r.problems.join('\n· ') + (r.fix ? '\n' + T('À lancer : ', 'Run: ') + r.fix : '') + '\n' + T('Clic : relancer le relais', 'Click: restart the relay');
}
function renderRelay(r) {
  const b = $('relaybtn');
  if (REMOTE || !r) { b.hidden = true; return; }
  b.hidden = false; b.disabled = relayBusy || !canWrite;
  b.classList.toggle('ko', !r.ok);
  b.textContent = relayBusy ? '📡 …' : r.ok ? '📡' : '📡 ' + T('accès distant coupé', 'remote access down');
  b.title = relayTitle(r);
}
async function restartRelay() {
  if (relayBusy) return;
  relayBusy = true; renderRelay(data && data.server && data.server.relay);
  say(T('relance du relais d’accès distant…', 'restarting the remote-access relay…'));
  try {
    const r = await post('/api/relay/restart');
    if (r && r.error) say(r.error);
    else if (r && r.ok) say(T('accès distant prêt', 'remote access ready') + (r.url ? ' : ' + r.url : ''));
    else if (r && r.problems) say(T('accès distant toujours coupé : ', 'remote access still down: ') + r.problems.join(' · ') + (r.fix ? ' — ' + T('lancer ', 'run ') + r.fix : ''));
    if (r && r.problems && data && data.server) data.server.relay = r;
  } catch { say(T('échec de la demande', 'request failed')); }
  relayBusy = false; renderRelay(data && data.server && data.server.relay);
}
$('relaybtn').addEventListener('click', restartRelay);

// « Lancée mais rien ne tourne » : bandeau en tête de liste, jusqu'à ce que la session démarre (il part alors seul) ou
// qu'on l'écarte. Cause probable : question d'approbation du dossier (dossier non approuvé, worktree neuf), sinon
// l'onglet lui-même (erreur, worktree non créé, onglet fermé).
function launchBanner(l) {
  const when = new Date(l.at).toLocaleTimeString(LOCALE, { hour:'2-digit', minute:'2-digit' });
  const b = el('div', 'rbanner launchlate');
  const head = el('div', 'lh', T('⚠ Nouvelle session lancée à ' + when + ' — rien ne tourne', '⚠ New session launched at ' + when + ' — nothing is running'));
  const x = el('button', 'x', '✕'); x.title = T('Écarter ce signal', 'Dismiss this alert');
  x.onclick = e => { e.stopPropagation(); dismissLaunch(l.id); };
  head.append(x);
  const cause = l.trust
    ? T('Probablement bloquée sur la question d’approbation du dossier (« Do you trust the files in this folder? ») : répondez dans l’onglet.', 'Probably waiting on the folder trust question ("Do you trust the files in this folder?"): answer in the tab.')
    : T('Aucune session n’a démarré : regardez l’onglet (erreur au lancement, worktree non créé, onglet fermé ?).', 'No session started: check the tab (launch error, worktree not created, tab closed?).');
  b.append(head, el('div', 'ld', (l.worktree ? T('worktree neuf · ', 'new worktree · ') : '') + (short(l.cwd) || l.cwd)), el('div', 'ld', cause));
  if (l.prompt) b.append(el('div', 'ld lp', '« ' + l.prompt + ' »'));
  b.title = l.cwd + T('\nLe signal disparaît seul dès que la session démarre.', '\nThe alert goes away by itself as soon as the session starts.');
  return b;
}
async function dismissLaunch(id) {
  if (!canWrite) return say(T('lecture seule à distance', 'read-only remotely'));
  try {
    await (await fetch('/api/launch-dismiss', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ id }) })).json();
    data.launches = (data.launches || []).filter(l => l.id !== id); renderList(); say(T('signal écarté', 'alert dismissed'));
  } catch { say(T('échec de la demande', 'request failed')); }
}
async function dismissReboot() { try { await post('/api/reboot-dismiss'); say(T('liste d\'avant le redémarrage oubliée', 'pre-restart list dismissed')); } catch { say(T('échec de la demande', 'request failed')); } tick(); }
function rebootPanel() {
  const rb = data.reboot; if (!rb) return null;
  const open = localStorage.getItem('sd.rebootOpen') !== '0';
  const box = el('div', 'reboot' + (open ? '' : ' folded'));
  const rt = el('button', 'rt'); rt.type = 'button'; rt.setAttribute('aria-expanded', String(open));
  rt.title = open ? T('Replier la liste', 'Collapse the list') : T('Déplier la liste', 'Expand the list');
  rt.onclick = () => { localStorage.setItem('sd.rebootOpen', open ? '0' : '1'); renderDetail(true); };
  rt.append(el('span', 'car', open ? '▾' : '▸'), ' ', T('Windows a redémarré — ' + plural(rb.sessions.length, 'session était ouverte', 'sessions étaient ouvertes') + ' le ' + new Date(rb.at).toLocaleString(LOCALE), 'Windows restarted — ' + plural(rb.sessions.length, 'session was open', 'sessions were open') + ' on ' + new Date(rb.at).toLocaleString('en-GB')));
  const npick = rb.sessions.filter(s => rebootPick.get(s.sessionId) !== false).length;
  if (!open) rt.append(el('span', 'rm', T(' · ' + npick + ' cochée' + (npick > 1 ? 's' : ''), ' · ' + npick + ' selected')));
  box.append(rt);
  const ul = el('div', 'rl');
  for (const s of rb.sessions) {
    if (!rebootPick.has(s.sessionId)) rebootPick.set(s.sessionId, true);
    const lab = el('label'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = rebootPick.get(s.sessionId); cb.onchange = () => rebootPick.set(s.sessionId, cb.checked);
    lab.append(cb, el('span', null, s.title), el('span', 'rm', (s.pr ? 'PR #' + s.pr + ' · ' : '') + T('active il y a ' + ago(data.now - s.lastActivity), 'active ' + ago(data.now - s.lastActivity) + ' ago')));
    ul.append(lab);
  }
  if (open) box.append(ul);
  const act = el('div', 'actions');
  const b1 = el('button', 'primary', T('Rouvrir la sélection', 'Reopen selected')); b1.onclick = () => reopenMany(rb.sessions.map(s => s.sessionId).filter(id => rebootPick.get(id)));
  const b2 = el('button', null, T('Tout cocher / décocher', 'Tick / untick all')); b2.onclick = () => { const all = rb.sessions.every(s => rebootPick.get(s.sessionId)); rb.sessions.forEach(s => rebootPick.set(s.sessionId, !all)); renderDetail(true); };
  const b3 = el('button', null, T('Ignorer', 'Dismiss')); b3.title = T('Ne plus proposer ces sessions (elles restent dans « Fermées, reprenables »)', 'Stop offering these sessions (they stay in "Closed, reopenable")'); b3.onclick = () => dismissReboot();
  act.append(b1, ...(open ? [b2] : []), b3); box.append(act);
  if (open) box.append(el('div', 'hint', T('Un onglet Windows Terminal par session, chacune reprise où elle s’était arrêtée (claude --resume).', 'One Windows Terminal tab per session, each resumed where it stopped (claude --resume).')));
  return box;
}

function prLink(it) {
  if (!it.pr || !/^https:\/\/github\.com\//.test(it.prUrl || '')) return null;
  const a = el('a', null, 'PR #' + it.pr); a.href = it.prUrl; a.target = '_blank'; a.rel = 'noopener'; a.onclick = e => e.stopPropagation(); return a;
}

/** Puce « poste » d'une session d'un autre poste : clic = ne montrer que ce poste. */
function machineTag(it) {
  const t = el('span', 'tag mach', '🖧 ' + it.machine);
  t.title = T('Session du poste « ' + it.machine + ' » — clic : ne montrer que ce poste', 'Session on machine "' + it.machine + '" — click: show only this machine');
  t.onclick = e => { e.stopPropagation(); const q = $('q'), tok = 'poste:' + it.machine; q.value = norm(q.value).split(/\s+/).includes(tok) ? q.value.split(/\s+/).filter(x => norm(x) !== tok).join(' ') : (q.value.trim() + ' ' + tok).trim(); renderList(); };
  return t;
}
// La liste se reconstruit à chaque rendu (toutes les 1 à 2 s). Remplacer ses nœuds perdait des clics : appui sur un
// en-tête de groupe, rendu, relâché sur le nouvel en-tête — le navigateur n'envoie pas de click (appui et relâché sur
// deux nœuds différents), le groupe ne se repliait pas. On construit hors du document puis on REPORTE sur les nœuds en
// place : un nœud de même clé (data-key : ligne ou en-tête de groupe) ou, sans clé, de même balise au même rang est
// gardé et mis à jour (attributs, texte, gestionnaires on…). Bonus : l'ancrage du défilement du navigateur marche
// (les nœuds restent), une ligne qui grandit au-dessus ne fait plus sauter ce qu'on lit.
const MORPH_HANDLERS = ['onclick', 'ondblclick', 'onmousedown', 'onmouseup', 'onpointerdown', 'onchange', 'oninput', 'onkeydown'];
function morphChildren(cur, next) {
  const keyOf = n => n.nodeType === 1 && n.dataset && n.dataset.key || '';
  const same = (o, n) => o.nodeType === n.nodeType && (o.nodeType !== 1 || o.tagName === n.tagName);
  // Un nœud n'est DÉPLACÉ que si l'ordre change vraiment : un déplacement retire le nœud du document, et un clic
  // commencé dessus est perdu comme avant. D'abord, retirer ce qui ne servira pas (clé absente du nouveau rendu, clé
  // en double : la même session peut figurer deux fois), sinon ce nœud resterait en travers et TOUS les suivants
  // seraient déplacés devant lui, à chaque rendu.
  const want = new Set([...next.childNodes].map(keyOf).filter(Boolean)), keyed = new Map();
  for (const c of [...cur.childNodes]) { const k = keyOf(c); if (!k) continue; if (want.has(k) && !keyed.has(k)) keyed.set(k, c); else c.remove(); }
  let at = cur.firstChild;
  for (const n of [...next.childNodes]) {
    const k = keyOf(n);
    if (k) while (at && !keyOf(at)) { const nx = at.nextSibling; at.remove(); at = nx; }   // nœud sans clé à la place d'une ligne : périmé
    let o = k ? keyed.get(k) : at && !keyOf(at) && same(at, n) ? at : null;
    if (k) keyed.delete(k);
    if (!o || !same(o, n)) { cur.insertBefore(n, at); continue; }
    if (o === at) at = at.nextSibling; else cur.insertBefore(o, at);
    if (o.nodeType !== 1) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; continue; }
    for (const x of [...o.attributes]) if (!n.hasAttribute(x.name)) o.removeAttribute(x.name);
    for (const x of n.attributes) if (o.getAttribute(x.name) !== x.value) o.setAttribute(x.name, x.value);
    for (const h of MORPH_HANDLERS) if (o[h] !== n[h]) o[h] = n[h];
    if ('checked' in n && o.checked !== n.checked) o.checked = n.checked;
    morphChildren(o, n);
  }
  while (at) { const nx = at.nextSibling; at.remove(); at = nx; }
}
function renderList() {
  spinPhase();
  const tokens = norm($('q').value).split(/\s+/).filter(Boolean);
  // Les fermées masquées ne réapparaissent que dans une recherche (étiquetées « masquée »).
  const items = allItems().filter(it => (!favOnly || it.fav) && (!it.hidden || tokens.some(t => !isStateToken(t))) && tokens.every(t => tagMatch(it, t) ?? it.hay.includes(t)));
  $('favonly').className = favOnly ? 'on' : '';
  $('sortbtn').className = sortMode === 'created' ? 'on' : '';
  $('sortbtn').title = sortMode === 'created' ? T('Trié par date de création (la plus récente d’abord) — clic : par dernière activité', 'Sorted by creation date (newest first) — click: by last activity') : T('Trié par dernière activité — clic : par date de création', 'Sorted by last activity — click: by creation date');
  const expandAll = tokens.length || favOnly;     // recherche ou filtre favoris : on cherche aussi dans les groupes repliés
  const list = el('div'); flat = [];   // construite hors du document, reportée sur #list à la fin (morphChildren)
  if (data.reboot) {               // après un redémarrage de Windows : rappel en tête, la vue d'ensemble propose la réouverture
    const b = el('div', 'rbanner', T('↻ ' + plural(data.reboot.sessions.length, 'session ouverte', 'sessions ouvertes') + ' avant le redémarrage — rouvrir…', '↻ ' + plural(data.reboot.sessions.length, 'session open', 'sessions open') + ' before the restart — reopen…'));
    b.title = T('Afficher la liste dans la vue d\'ensemble', 'Show the list in the overview'); b.onclick = () => select(null); list.append(b);
  }
  // Nouvelle session lancée il y a plus d'une minute sans qu'aucune session n'ait démarré (serveur : launch-watch.ts).
  for (const l of data.launches || []) list.append(launchBanner(l));
  // Autres postes injoignables (éteints, en veille) : dit en tête, sans rien bloquer — leurs sessions reviennent seules.
  for (const p of peersDown(data.peers)) {
    const b = el('div', 'rbanner peerdown', '🖧 ' + p.name + T(' — poste injoignable', ' — machine unreachable') + (p.at ? T(' · vu il y a ', ' · seen ') + ago(data.now - p.at) + T('', ' ago') : ''));
    b.title = (p.error || T('pas encore lu', 'not read yet')) + T('\nSes sessions réapparaissent dès qu’il répond.', '\nIts sessions come back as soon as it answers.');
    b.style.cursor = 'default'; list.append(b);
  }
  // Brouillons de nouvelle session : en tête, avant tout. Recherche : seulement ceux qui correspondent ; filtre favoris : aucun.
  const drafts = favOnly ? [] : (data.drafts || []).filter(d => tokens.every(t => norm(draftHay(d)).includes(t)));
  if (drafts.length) {
    const isCollapsed = !expandAll && collapsed.has('drafts');
    const head = el('div', 'grp');
    head.append(el('span', 'car', isCollapsed ? '▸' : '▾'), el('span', null, T('📝 Brouillons', '📝 Drafts')), el('span', 'n', drafts.length));
    head.dataset.key = 'g:drafts';
    head.title = T('Nouvelles sessions enregistrées sans être lancées — clic sur une ligne : la relire, la modifier, la lancer', 'New sessions saved without being launched — click a row: read it, edit it, launch it');
    head.onclick = () => { collapsed.has('drafts') ? collapsed.delete('drafts') : collapsed.add('drafts'); localStorage.setItem('cc.collapsed', JSON.stringify([...collapsed])); renderList(); };
    list.append(head);
    if (!isCollapsed) for (const d of drafts) {
      const row = el('div', 'row-s draft' + (newMode && newPrefill && newPrefill.draft && newPrefill.draft.id === d.id ? ' sel' : ''));
      row.append(el('span', 'dot'), el('span', 't', draftTitle(d)), el('span', 'age', ago(data.now - d.updatedAt)));
      row.append(el('span', 'sub', [short(d.cwd) || T('dossier à choisir', 'folder to choose'), d.branch && '⎇ ' + d.branch, d.forkFrom && '⑂ ' + (d.forkTitle || d.forkFrom.slice(0, 8)), d.attachments.length && '📎 ' + d.attachments.length].filter(Boolean).join(' · ')));
      row.title = d.prompt.slice(0, 600) || draftTitle(d); row.onclick = () => openDraft(d);
      list.append(row);
    }
  }
  // Consultées récemment : raccourci en tête de liste. Pas pendant une recherche ou le filtre favoris (bruit),
  // et ces lignes n'entrent pas dans la navigation ↑ ↓ (la session y figure déjà dans son groupe d'état).
  if (!expandAll) {
    const all = new Map(allItems().filter(it => !it.hidden).map(it => [it.key, it]));
    const rec = recent.filter(r => all.has(r.k)).slice(0, RECENT_SHOWN);
    if (rec.length) {
      const isCollapsed = collapsed.has('recent');
      const head = el('div', 'grp');
      head.append(el('span', 'car', isCollapsed ? '▸' : '▾'), el('span', null, T('Consultées récemment', 'Recently viewed')), el('span', 'n', rec.length));
      head.dataset.key = 'g:recent';
      head.title = T('Les dernières sessions ouvertes dans cette page  ( b : revenir à la précédente )', 'The last sessions opened in this page  ( b: back to the previous one )');
      head.onclick = () => { collapsed.has('recent') ? collapsed.delete('recent') : collapsed.add('recent'); localStorage.setItem('cc.collapsed', JSON.stringify([...collapsed])); renderList(); };
      list.append(head);
      if (!isCollapsed) for (const r of rec) {
        const it = all.get(r.k);
        const row = el('div', 'row-s ' + (it.look || it.state) + (it.key === selected ? ' sel' : ''));
        const tt = el('span', 't'); if (it.fav) tt.append(el('span', 'star', '★ ')); tt.append(label(it));
        row.append(el('span', 'dot'), tt, el('span', 'age', T('vue il y a ' + ago(Date.now() - r.at), 'viewed ' + ago(Date.now() - r.at) + ' ago')));
        row.append(el('span', 'sub', it.kind === 'run' ? runSub(it) : it.kind === 'pass' ? passSub(it) : (it.kind === 'closed' ? T('fermée — terminal disparu', 'closed — terminal gone') : LABEL[it.state]) + (it.lastPrompt ? ' · ' + it.lastPrompt : '')));
        row.title = label(it); row.onclick = () => select(it.key); row.ondblclick = () => primary(it);
        list.append(row);
      }
    }
  }
  for (const g of groupList()) {
    // 🤖 et automates : en cours d'abord (runs, passes et autres claude -p), puis du plus récent au plus ancien.
    const live = it => it.kind === 'run' ? it.run.running : it.kind === 'pass' ? it.running : isLive(it);
    const byTime = g.key === 'auto' || !!g.auto;
    const rows = items.filter(it => g.states.includes(it.state)).sort(sortMode === 'created'
      ? (byTime ? (a, b) => (live(b) - live(a)) || createdOf(b) - createdOf(a) : (a, b) => (b.fav - a.fav) || createdOf(b) - createdOf(a))
      : byTime ? (a, b) => (live(b) - live(a)) || (b.at || b.since) - (a.at || a.since)
      : (a, b) => (b.fav - a.fav) || (g.asc ? (TODO.indexOf(a.state) - TODO.indexOf(b.state) || a.since - b.since) : b.since - a.since));
    if (!rows.length && (g.key !== 'todo' || expandAll) && !(g.auto && !expandAll)) continue;   // « À traiter » et les automates restent visibles même vides
    const isCollapsed = !expandAll && collapsed.has(g.key);
    // 🤖 replié : on garde sous les yeux ce qui compte — en cours, en échec, PR qui attend l'utilisateur.
    const urgent = g.key === 'auto' ? rows.filter(it => live(it) || it.look === 'waiting' || it.look === 'ask') : g.auto ? rows.filter(it => live(it) || it.look === 'waiting') : [];
    const head = el('div', 'grp'); head.dataset.key = 'g:' + g.key;
    const gTitle = g.key === 'auto' ? autoTitle(g.title, rows) : g.auto ? g.title + (autoGroupTitle(g.auto) ? ' — ' + autoGroupTitle(g.auto) : '') : g.title;
    head.append(el('span', 'car', isCollapsed ? '▸' : '▾'), el('span', null, gTitle + (g.key === 'closed' && closedData.days ? T(' · ' + closedData.days + ' j', ' · ' + closedData.days + ' d') : '')), el('span', 'n', rows.length));
    if (g.auto) head.title = T('Passes du jour qui ont agi ou échoué, et la passe en cours. Les passes sans effet sont comptées ici sans ligne. Replié : seulement en cours et en échec.', "Today's passes that acted or failed, and the running pass. Passes with no effect are counted here without a row. Collapsed: only running and failed.") + (g.auto.last ? T('\nDernière passe : ', '\nLast pass: ') + g.auto.last.summary : '');
    if (g.key === 'auto') head.title = T('Runs du lanceur depuis minuit et tout run en cours, plus les autres claude -p. Replié : seulement en cours, en échec et PR qui attend ta validation. L’historique long est dans la vue 🤖 ( l ).', 'Launcher runs since midnight and any running run, plus the other claude -p. Collapsed: only running, failed and PRs waiting for your approval. The long history is in the 🤖 view ( l ).');
    if (g.key === 'todo' && rows.some(it => it.state === 'done' || it.state === 'ask')) {
      const all = el('a', null, T('tout marquer vu', 'mark all seen')); all.href = '#'; all.style.textTransform = 'none'; all.style.letterSpacing = '0'; all.style.fontWeight = '400';
      all.onclick = async e => { e.preventDefault(); e.stopPropagation(); try { await post('/api/ack?all=1'); say(T('sessions terminées marquées comme vues', 'finished sessions marked as seen')); tick(); } catch {} };
      head.insertBefore(all, head.lastChild);
    }
    if (g.key === 'closed' && !expandAll) {
      const merged = rows.filter(it => it.prInfo && it.prInfo.state === 'MERGED');
      if (merged.length) {
        const a = el('a', 'lnk', T('masquer les ' + merged.length + ' à PR mergée', 'hide the ' + merged.length + ' with a merged PR')); a.href = '#';
        a.title = T('Retire de la liste les sessions fermées dont la PR est mergée (réversible, transcripts intacts)', 'Removes from the list the closed sessions whose PR is merged (reversible, transcripts untouched)');
        a.onclick = e => { e.preventDefault(); e.stopPropagation(); setHidden(merged, true); };
        head.insertBefore(a, head.lastChild);
      }
    }
    head.onclick = () => { collapsed.has(g.key) ? collapsed.delete(g.key) : collapsed.add(g.key); localStorage.setItem('cc.collapsed', JSON.stringify([...collapsed])); renderList(); };
    list.append(head);
    if (isCollapsed && !urgent.length) continue;
    if (!rows.length && g.auto) continue;
    if (!rows.length) { const e = el('div', 'row-s empty'); e.append(el('span'), el('span', 'sub', T('rien à traiter', 'nothing to handle'))); e.style.cursor = 'default'; list.append(e); continue; }
    for (const it of isCollapsed ? urgent : rows) {
      flat.push(it.key);
      const r = el('div', 'row-s ' + (it.look || it.state) + (it.kind === 'run' || it.kind === 'pass' ? ' run' : '') + (it.key === selected ? ' sel' : ''));
      r.dataset.key = it.key;
      const tt = el('span', 't'); if (it.fav) tt.append(el('span', 'star', '★ ')); tt.append(label(it));
      { const d = driftTag(it); if (d) tt.append(d); }
      if (it.hidden) tt.append(el('span', 'tag hid', T('masquée', 'hidden')));
      if (it.machine) tt.append(machineTag(it));
      const age = el('span', 'age'); if (it.model) age.append(modelBadge(it.model, true)); r.append(el('span', 'dot'), tt, age); age.append((it.tokens ? ktok(it.tokens) + ' · ' : '') + (sortMode === 'created' ? T('créée il y a ' + ago(data.now - createdOf(it)), 'created ' + ago(data.now - createdOf(it)) + ' ago') : ago(data.now - it.since)));
      const merged = (closable(it) ? T('✓ peut se fermer · ', '✓ can be closed · ') : it.prInfo && it.prInfo.state === 'MERGED' ? T('PR mergée · ', 'PR merged · ') : '') + (it.status === 'shell' && it.state !== 'shell' ? T('commande en arrière-plan · ', 'background command · ') : '');
      const sub = el('span', 'sub', it.kind === 'run' ? runSub(it) : it.kind === 'pass' ? passSub(it) : isLive(it) ? merged + (it.state === 'idle' ? (it.lastPrompt || it.name) : LABEL[it.state] + (it.lastPrompt ? ' · ' + it.lastPrompt : '')) : T('fermée · ', 'closed · ') + merged + (it.lastPrompt || short(it.cwd)));
      if (isLive(it) && it.state === 'busy') sub.replaceChildren(merged, spinVerb(it), it.lastPrompt ? ' · ' + it.lastPrompt : '');
      r.append(sub);
      const chips = tagChips(it, 'tags'); if (chips) r.append(chips);
      const inb = teamsInboundOf(it);
      if (inb) { const x = el('span', 'tw inb', T('📥 demande Teams de ' + (inb.chatLabel || inb.from), '📥 Teams request from ' + (inb.chatLabel || inb.from))); x.title = T('Session ouverte automatiquement pour un message reçu en direct sur Teams : elle propose une réponse, rien ne part sans toi', 'Session opened automatically for a direct message received on Teams: it suggests a reply, nothing is sent without you'); r.append(x); }
      const tws = teamsWaitsOf(it);
      if (tws.length) {
        const tw = el('span', 'tw' + (tws.some(w => w.status === 'replied') ? ' rep' : tws.some(w => w.alertedAt) ? ' alert' : ''), teamsWaitLine(tws[0], data.now, data.teams.reminders) + (tws.length > 1 ? ' · +' + (tws.length - 1) : ''));
        tw.title = tws.map(w => teamsWaitLine(w, data.now, data.teams.reminders) + T('\n  « ' + w.excerpt + ' »', '\n  "' + w.excerpt + '"')).join('\n');
        r.append(tw);
      }
      const sch = isLive(it) ? schedOf(it) : [];
      if (sch.length) { const x = el('span', 'tw sched', schedLine(sch[0], data.now) + (sch.length > 1 ? ' · +' + (sch.length - 1) : '')); x.title = schedList(it) + (schedFragile(it).length ? '\n\n' + SCHED_WARN : ''); r.append(x); }
      const vals = validationsOf(it), vb = validationBadge(vals);
      if (vb) { const x = el('span', 'tw val' + (vals.refused || vals.unqualified ? ' ref' : vals.expected ? ' pre' : ''), vb); x.title = vals.items.filter(i => !i.withdrawn).map(i => validationLine(i, data.now) + '\n  ' + i.question).join('\n'); r.append(x); }
      if (canWrite && closable(it)) {                    // « peut se fermer » (inactive, tout est mergé) : ✕ la ferme sans ouvrir la session
        const line = el('span', 'sug'), bx = el('button', 'sgo', T('✕ Fermer', '✕ Close'));
        bx.title = T('Inactive et tout est mergé : quitter la session (/exit, après confirmation) — la conversation reste reprenable depuis « Fermées »', 'Idle and everything is merged: quit the session (/exit, after confirmation) — the conversation stays reopenable from "Closed"');
        bx.onclick = e => { e.stopPropagation(); closeSession(it); };
        bx.ondblclick = e => e.stopPropagation();
        line.append(bx); r.append(line);
      }
      const sg =canWrite && isLive(it) && (it.status === 'idle' || it.status === 'shell') && it.suggestion;
      if (sg) {                                          // proposition de Claude Code : ▶ la lance sans ouvrir la session
        const line = el('span', 'sug'), cut = sg.endsWith('…');
        const go = el('button', 'sgo', '▶');
        go.title = cut ? T('Coupée à l’écran : lancée telle que Claude Code l’a écrite (Tab puis Entrée dans le terminal)', 'Cut off on screen: launched as Claude Code wrote it (Tab then Enter in the terminal)') : T('Lancer cette proposition (revérifiée à l’écran juste avant)', 'Launch this suggestion (checked again on screen just before)');
        go.onclick = e => { e.stopPropagation(); launchSuggestion(it, sg); };
        go.ondblclick = e => e.stopPropagation();
        line.append(go, el('span', 'stx', '💡 ' + sg)); line.title = T('Proposition de Claude Code : ' + sg, 'Claude Code suggestion: ' + sg); r.append(line);
      }
      r.title = label(it) + (it.model ? T('\nmodèle : ', '\nmodel: ') + it.model : '') + (it.tokens ? T('\ncontexte : ' + it.tokens.toLocaleString(LOCALE) + ' tokens', '\ncontext: ' + it.tokens.toLocaleString('en-GB') + ' tokens') : '');
      r.onclick = () => select(it.key);
      r.ondblclick = () => primary(it);
      list.append(r);
    }
  }
  if (!flat.length && expandAll) list.append(el('div', 'grp', favOnly && !tokens.length ? T('Aucun favori — touche f sur une session', 'No favourites — press f on a session') : T('Aucun résultat', 'No results')));
  morphChildren($('list'), list);
  const unread = data.notifs.filter(nf => nf.at > Number(localStorage.getItem('cc.notifSeen') || 0)).length; $('belln').textContent = unread ? unread : '';
  const todo = allItems().filter(it => TODO.includes(it.state)).length;
  document.title = (todo ? '(' + todo + ') ' : '') + T('Sessions Claude Code', 'Claude Code sessions');
  refreshHoverCard();
}

// Survol d'une ligne de la liste : le dernier message de Claude (et sa proposition 💡), sans ouvrir la session.
// La ligne ne montre que TON dernier prompt et le bouton ▶ : pour savoir si la proposition vaut d'être lancée, il
// faut lire ce que Claude vient de dire. La liste est reconstruite à chaque rendu (toutes les 2 s) : la carte vit
// hors de la liste, l'écoute est déléguée à #list et renderList la rafraîchit. Pas de carte sur écran tactile ou
// étroit (pas de survol), ni pour la session déjà ouverte à droite (son message y est affiché).
const HOVER_DELAY = 350, CAN_HOVER = matchMedia('(hover: hover)');
let hoverKey = null, hoverShown = false, hoverTimer = null, hoverMuted = null;
function hoverCardEl() {
  let c = $('hovercard');
  if (!c) { c = el('div'); c.id = 'hovercard'; c.hidden = true; document.body.append(c); }
  return c;
}
function hideHoverCard() { clearTimeout(hoverTimer); hoverTimer = null; hoverShown = false; const c = $('hovercard'); if (c) c.hidden = true; }
function refreshHoverCard() {
  if (!hoverShown) return;
  const it = hoverKey && byKey(hoverKey), row = it && [...$('list').querySelectorAll('.row-s')].find(r => r.dataset.key === hoverKey);
  const reply = it && it.reply ? String(it.reply).trim() : '';
  if (!row || !reply || !CAN_HOVER.matches || NARROW.matches || hoverKey === selected) { const c = $('hovercard'); if (c) c.hidden = true; return; }
  const c = hoverCardEl(); c.className = it.look || it.state || '';
  const sig = hoverKey + '\n' + reply + '\n' + (it.suggestion || '');
  if (c.dataset.sig !== sig) {                     // même contenu : on ne touche pas au DOM (pas de saut de défilement)
    c.dataset.sig = sig; c.replaceChildren(el('div', 'hh', T('Dernier message de Claude', "Claude's last message")), mdBody('hb', reply));
    if (it.suggestion) c.append(el('div', 'hs', '💡 ' + it.suggestion));
  }
  c.hidden = false;
  const a = $('list').getBoundingClientRect(), r = row.getBoundingClientRect();
  c.style.left = Math.round(a.right + 8) + 'px';
  c.style.top = Math.round(Math.max(8, Math.min(r.top, innerHeight - c.offsetHeight - 8))) + 'px';
  const hb = c.querySelector('.hb'); hb.scrollTop = hb.scrollHeight;   // message long : c'est sa fin qui dit où on en est
}
function hoverRow(key) {
  if (key === hoverKey) return;
  hideHoverCard(); hoverKey = key; if (key !== hoverMuted) hoverMuted = null;
  if (!key || key === hoverMuted) return;
  hoverTimer = setTimeout(() => { hoverShown = true; refreshHoverCard(); }, HOVER_DELAY);
}
$('list').addEventListener('mouseover', e => { const r = e.target.closest ? e.target.closest('.row-s') : null; hoverRow(r && r.dataset.key ? r.dataset.key : null); });
$('list').addEventListener('mouseleave', () => hoverRow(null));
$('list').addEventListener('scroll', () => { if (hoverShown) refreshHoverCard(); }, { passive: true });
$('main').addEventListener('scroll', () => { const s = $('dstick'); if (s) s.classList.toggle('stuck', $('main').scrollTop > 0); }, { passive: true });   // filet sous le bandeau collant, seulement quand on a défilé
$('list').addEventListener('click', () => { hoverMuted = hoverKey; hideHoverCard(); });   // on ouvre la session : la carte ne masque pas le détail

// Sessions consultées : une session compte comme « vue » si elle reste sélectionnée 1,5 s (parcourir la
// liste au clavier ne pollue pas l'historique), ou aussitôt qu'on agit dessus (onglet, réouverture, réponse).
const RECENT_KEEP = 30, RECENT_SHOWN = 6;
let recent = (() => { try { return JSON.parse(localStorage.getItem('cc.recent') || '[]').filter(r => r && r.k); } catch { return []; } })();
let recentTimer = null;
function touchRecent(key) {
  if (!key) return;
  recent = [{ k:key, at:Date.now() }].concat(recent.filter(r => r.k !== key)).slice(0, RECENT_KEEP);
  localStorage.setItem('cc.recent', JSON.stringify(recent));
}
function back() {                                  // revenir à la session consultée juste avant
  const keys = new Set(allItems().map(it => it.key));
  const prev = recent.find(r => r.k !== selected && keys.has(r.k));
  if (!prev) { say(T('aucune autre session consultée récemment', 'no other recently viewed session')); return; }
  if (selected) touchRecent(selected);
  select(prev.k, true); touchRecent(prev.k); renderList();
}

// Écran étroit (téléphone) : liste OU détail, pas les deux. Ouvrir une session (ou le tableau, le lanceur…)
// passe au détail plein écran ; « ← Sessions », Échap ou le bouton retour du téléphone reviennent à la liste — le retour
// passe par l'historique de la page (voir « Navigation » plus bas), commun à tous les écrans.
// Sur grand écran la classe est posée aussi mais sans effet (la CSS ne s'en sert que sous 820 px).
const NARROW = matchMedia('(max-width: 820px)');   // lu aussi par la vue conversation, le texte d'écran et le survol
function setPane(detail) {
  if (detail === document.body.classList.contains('mdetail')) return;
  document.body.classList.toggle('mdetail', detail); if (detail) $('main').scrollTop = 0;
}
function setMobileTitle(text, state) {
  const t = $('mtitle'); t.className = 'chip ' + (state || ''); t.replaceChildren(); if (state) t.append(el('span', 'dot')); t.append(el('span', 't', text));
  document.title = (text.length > 60 ? text.slice(0, 59) + '…' : text) + T(' — Sessions Claude Code', ' — Claude Code sessions');   // le menu de Précédent / Suivant liste les écrans par leur nom
}

// ── Navigation : l'adresse dit l'écran ouvert ──────────────────────────────────────────────────────────────────────
// Chaque écran a son adresse : ?sel=<clé> (session, run, passe), ?view=board|launcher|chats|new|bc, ?view=find&q=…,
// rien pour la vue d'ensemble. Changer d'écran ajoute une entrée d'historique : Précédent / Suivant (bouton, souris,
// Alt+←, téléphone) parcourent les écrans, F5 rouvre le même, l'adresse se copie. Un seul point d'écriture, syncRoute,
// appelé par renderDetail : les open*/close*/select n'ont rien à faire. Revenir à l'écran juste d'avant (Échap, Fermer,
// « ← Sessions ») RECULE dans l'historique au lieu d'empiler un doublon ; affiner une recherche remplace l'entrée.
// ?run= et ?pass= (notifications) restent des points d'entrée : une fois ouverts, l'adresse devient ?sel=.
function routeUrl(r) {
  const p = new URLSearchParams();
  if (r.view) p.set('view', r.view);
  if (r.view === 'find' && r.q) p.set('q', r.q);
  if (!r.view && r.sel) p.set('sel', r.sel);
  const s = p.toString(); return s ? '?' + s : '';
}
function routeParse(search) {
  const p = new URLSearchParams(search), v = p.get('view');
  if (v && ['board', 'launcher', 'chats', 'new', 'bc', 'find'].includes(v)) return v === 'find' ? { view: v, q: p.get('q') || '' } : { view: v };
  return p.get('sel') ? { sel: p.get('sel') } : {};
}
// Que faire de l'historique pour aller à url, l'entrée courante étant st (history.state) et stack l'adresse de chaque
// entrée de la page par rang : rien, remplacer (1re entrée, recherche affinée, écran corrigé), reculer (l'écran demandé
// est celui juste d'avant) ou empiler.
function navStep(st, stack, url, replace) {
  if (!st || !st.sd) return { op: 'replace', idx: 0 };
  if (st.url === url) return { op: 'none', idx: st.idx };
  const find = u => /[?&]view=find(&|$)/.test(u);
  if (replace || (find(st.url) && find(url))) return { op: 'replace', idx: st.idx };
  if (st.idx > 0 && stack[st.idx - 1] === url) return { op: 'back', idx: st.idx - 1 };
  return { op: 'push', idx: st.idx + 1 };
}
let navStack = (() => { try { return JSON.parse(sessionStorage.getItem('sd.nav') || '[]'); } catch { return []; } })();
let navApplying = false, navReplace = false, navBacking = false, pendingRoute = null;
function routeNow() {
  const v = launchMode ? 'launcher' : chatsMode ? 'chats' : boardMode ? 'board' : newMode ? 'new' : bcMode ? 'bc' : findMode ? 'find' : null;
  return v ? { view: v, q: v === 'find' ? findQ : '' } : { sel: selected || '' };
}
function syncRoute() {
  if (navApplying || navBacking || pendingRoute) return;   // écran en cours d'ouverture / recul en vol / adresse d'arrivée pas encore appliquée
  const url = routeUrl(routeNow()), s = navStep(history.state, navStack, url, navReplace); navReplace = false;
  if (s.op === 'none') return;
  if (s.op === 'back') { navBacking = true; history.back(); return; }   // le popstate trouve l'écran déjà affiché
  if (s.op === 'push') navStack.length = s.idx;
  navStack[s.idx] = url; try { sessionStorage.setItem('sd.nav', JSON.stringify(navStack)); } catch {}
  history[s.op === 'push' ? 'pushState' : 'replaceState']({ sd: 1, idx: s.idx, url }, '', location.pathname + url);
}
function applyRoute(r) {
  navApplying = true;
  try {
    if (r.view === 'launcher') openLauncher(); else if (r.view === 'chats') openChats(); else if (r.view === 'board') openBoard();
    else if (r.view === 'new') openNew(); else if (r.view === 'bc') openBc();
    else if (r.view === 'find') { $('q').value = r.q; renderList(); if (r.q) runFind(r.q); }
    else select(r.sel || null);
  } finally { navApplying = false; }
  navReplace = true; syncRoute();   // écran indisponible (module coupé) : l'adresse reprend celui réellement affiché
}
addEventListener('popstate', e => {
  const ours = navBacking; navBacking = false;
  // Recul demandé par la page (retour à l'écran d'avant) : l'écran affiché fait foi — il a pu changer entre-temps
  // (openRun ferme le lanceur PUIS ouvre le run) ; on ne le défait pas, on corrige l'adresse.
  if (ours) { navReplace = true; syncRoute(); return; }
  const r = e.state && e.state.sd ? routeParse(e.state.url) : routeParse(location.search);
  if (routeUrl(routeNow()) !== routeUrl(r)) applyRoute(r);
});

function select(key, scroll) {
  clearTimeout(recentTimer);
  if (key) recentTimer = setTimeout(() => { if (selected === key) { touchRecent(key); renderList(); } }, 1500);
  selected = key; lastScreen = null; newMode = false; findMode = false; bcMode = false; boardMode = false; launchMode = false; chatsMode = false;
  setPane(!!key);
  key ? sessionStorage.setItem('cc.sel', key) : sessionStorage.removeItem('cc.sel');
  renderList(); renderDetail(true);
  if (scroll) { const r = document.querySelector('.row-s.sel'); if (r) r.scrollIntoView({ block:'nearest' }); }
  const it = key && byKey(key);
  if (it && (it.state === 'done' || it.state === 'ask')) post(sx(it, '/api/ack?id=' + it.sessionId)).catch(() => {});
  refreshScreen();
}

// Ouverte hors du poste (tailscale serve) : LECTURE SEULE — le serveur refuse toute action (403), la page masque les commandes.
// Le serveur dit s'il accepte l'écriture (/api/whoami) : à distance, seulement pour le propriétaire du poste sur Tailscale.
// En attendant sa réponse — ou s'il refuse — la page reste en lecture seule.
const REMOTE = !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
let canWrite = !REMOTE;
function whoami() {
  fetch('/api/whoami', { cache:'no-store' }).then(r => r.json()).then(w => { const was = canWrite; canWrite = !!w.write; document.body.classList.toggle('ro', !canWrite); if (canWrite && !was) say(T('écriture autorisée à distance (' + w.login + ')', 'remote writing allowed (' + w.login + ')')); renderDetail(true); }).catch(() => {});
}
if (REMOTE) { document.body.classList.add('ro', 'remote'); whoami(); }
// ───────────── Configuration du poste (config.json), éditée depuis le poste seulement ─────────────
// Le texte est vérifié par le serveur (JSON, schéma, clés protégées) avant d'être enregistré tel que tapé ; les clés
// qui font exécuter un programme restent à changer dans le fichier. Enregistré : appliqué tout de suite, sauf ce qui
// attend un redémarrage (dit dans le compte rendu).
let cfgBase = null;
async function openCfg() {
  if (REMOTE) return;
  const d = $('cfgdlg'), out = $('cfgout');
  let r;
  try { r = await (await fetch('/api/config', { cache:'no-store' })).json(); } catch { say(T('configuration illisible', 'configuration unreadable')); return; }
  if (!r || typeof r.text !== 'string') { say((r && r.error) || T('configuration illisible', 'configuration unreadable')); return; }
  cfgBase = r.base; $('cfgtext').value = r.text;
  $('cfgfile').textContent = r.file + (r.exists ? '' : T(' (absent : il sera créé)', ' (missing: it will be created)'));
  $('cfgprot').textContent = T('Non modifiables ici, à changer dans le fichier : ', 'Not editable here, change them in the file: ') + (r.protected || []).join(', ');
  $('cfgsave').disabled = !r.writable; $('cfgsave').title = r.writable ? '' : T('serveur en lecture seule', 'read-only server');
  out.textContent = ''; out.className = 'cfgout';
  if (!d.open) d.showModal();
  $('cfgtext').focus();
}
// Compte rendu d'une vérification ou d'un enregistrement (rendu PUR à partir de la réponse du serveur : testé).
function cfgLines(r, kind) {
  const L = [];
  if (!r) return [['bad', T('pas de réponse du serveur', 'no answer from the server')]];
  if (r.conflict) L.push(['bad', T('Le fichier a changé depuis son ouverture : rouvrir pour repartir de sa version actuelle (rien n’a été écrit).', 'The file changed since it was opened: reopen it to start from its current version (nothing was written).')]);
  if (r.error) { L.push(['bad', T('JSON illisible : ', 'Unreadable JSON: ') + r.error]); return L; }
  if (Array.isArray(r.protectedChanged) && r.protectedChanged.length) L.push(['bad', T('Clés protégées modifiées (à changer dans le fichier) : ', 'Protected keys changed (change them in the file): ') + r.protectedChanged.join(', ')]);
  if (Array.isArray(r.problems)) for (const p of r.problems) L.push(['bad', p]);
  const ch = Array.isArray(r.changed) ? r.changed : [];
  if (r.saved) {
    L.push(['ok', T('Enregistré', 'Saved') + (r.backup ? T(' — version précédente : ', ' — previous version: ') + r.backup : '') + '.']);
    if (Array.isArray(r.restart) && r.restart.length) L.push(['warn', T('Au prochain démarrage du serveur : ', 'At the next server start: ') + r.restart.join(', ')]);
    else L.push(['ok', T('Appliqué tout de suite.', 'Applied at once.')]);
  } else if (r.ok && kind === 'check') L.push(['ok', ch.length ? T('Conforme. ', 'Valid. ') : T('Conforme, rien de modifié.', 'Valid, nothing changed.')]);
  if (ch.length && !r.conflict) L.push(['', T('Modifié : ', 'Changed: ') + ch.join(', ')]);
  return L;
}
async function cfgSend(kind) {
  const out = $('cfgout'), text = $('cfgtext').value;
  const body = JSON.stringify(kind === 'save' ? { text, base: cfgBase } : { text });
  let r = null;
  try { r = await (await fetch('/api/config/' + kind, { method:'POST', headers:{ 'content-type':'application/json' }, body })).json(); } catch { r = null; }
  out.textContent = '';
  for (const [cls, t] of cfgLines(r, kind)) { const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = t; out.appendChild(d); }
  if (r && r.saved && typeof r.text === 'string') { cfgBase = r.base; $('cfgtext').value = r.text; say(T('configuration enregistrée', 'configuration saved')); }
}
async function post(path) {
  if (!canWrite) return { error: T('lecture seule à distance', 'read-only remotely'), code: 4 };
  if (link.down) return { error: T('serveur injoignable — reconnexion en cours', 'server unreachable — reconnecting'), code: 5 };
  const r = await fetch(path, { method:'POST' }); return r.json();
}
async function openTab(it) {
  if (!it || it.kind !== 'open') return;                 // l'onglet d'un autre poste ne s'affiche pas d'ici
  say(T('ouverture de « ' + label(it) + ' »…', 'opening "' + label(it) + '"…'));
  try { const r = await post('/api/focus?pid=' + it.pid);
    if (r.code === 0) { noTab.delete(it.key); say(T('onglet affiché', 'tab shown')); }
    else { noTab.add(it.key); say(r.code === 3 ? T('onglet introuvable — tu peux la relancer dans un nouvel onglet', 'tab not found — you can restart it in a new tab') : T('console de la session inaccessible — tu peux la relancer dans un nouvel onglet', 'session console unreachable — you can restart it in a new tab')); renderDetail(); } }
  catch { say(T('échec de la demande', 'request failed')); }
}
const noTab = new Set();     // sessions dont l'onglet n'a pas pu être affiché : on propose la relance
async function relaunch(it) {
  if (!it || it.kind !== 'open') return;
  // Sans confirmation : rien ne se perd (session inactive, invite vide exigées par le serveur ; conversation reprise).
  say(T('relance de « ' + label(it) + ' »…', 'restarting "' + label(it) + '"…'));
  relaunching = { key: it.key, until: Date.now() + 90000 };
  try { const r = await post('/api/relaunch?pid=' + it.pid);
    if (r.error) { relaunching = null; say(T('non relancée : ', 'not restarted: ') + r.error); } else { noTab.delete(it.key); say(T('relancée dans un nouvel onglet — elle réapparaît dans quelques secondes', 'restarted in a new tab — it reappears in a few seconds')); } }
  catch { relaunching = null; say(T('échec de la demande', 'request failed')); }
  tick();
}
// Entre la fermeture et la réapparition dans le nouvel onglet, la session n'est dans aucune liste pendant quelques
// secondes : la sélection est gardée, pour que son détail revienne tout seul au lieu de la chercher dans la liste.
let relaunching = null;
const awaitingRelaunch = key => !!relaunching && relaunching.key === key && Date.now() < relaunching.until;
async function closeSession(it) {
  if (!it || it.kind !== 'open') return;
  if (!confirm(T('Fermer « ' + label(it) + ' » ?\n\nLa conversation est conservée : elle passe dans « Fermées, reprenables ». L’onglet du terminal reste ouvert sur une invite PowerShell.', 'Close "' + label(it) + '"?\n\nThe conversation is kept: it moves to "Closed, reopenable". The terminal tab stays open on a PowerShell prompt.'))) return;
  say(T('fermeture de « ' + label(it) + ' »…', 'closing "' + label(it) + '"…'));
  try {
    let r = await post('/api/close?pid=' + it.pid);
    if (r.needForce && r.jobs) {
      if (!confirm(T(r.error + '.\n\n' + schedList(it) + '\n\nFermer quand même ? Elle ne s’exécutera pas.', r.error + '.\n\n' + schedList(it) + '\n\nClose anyway? It will not run.'))) { say(T('fermeture annulée', 'close cancelled')); return; }
      r = await post('/api/close?pid=' + it.pid + '&force=1');
    } else if (r.needForce) {
      if (!confirm(T(r.error + '.\n\nL’arrêter de force ? Le travail en cours dans ce tour sera perdu ; la conversation reste reprenable.', r.error + '.\n\nForce it to stop? The work in progress in this turn will be lost; the conversation stays reopenable.'))) { say(T('fermeture annulée', 'close cancelled')); return; }
      r = await post('/api/close?pid=' + it.pid + '&force=1');
    }
    say(r.error ? T('non fermée : ', 'not closed: ') + r.error : T((r.forced ? 'session arrêtée' : 'session fermée') + ' — reprenable depuis « Fermées »', (r.forced ? 'session stopped' : 'session closed') + ' — reopenable from "Closed"'));
  } catch { say(T('échec de la demande', 'request failed')); }
  tick(); loadClosed();
}
// Masquer des sessions FERMÉES : elles sortent de la liste, des consultées et des compteurs ; la recherche les retrouve.
let hiddenSet = new Set();
async function setHidden(list, on) {
  list = list.filter(it => it && it.kind === 'closed'); if (!list.length) return;
  if (on && list.length > 1 && !confirm(T('Masquer ' + list.length + ' sessions fermées ?\n\nElles restent trouvables par la recherche et peuvent être ré-affichées ; les transcripts ne sont pas touchés.', 'Hide ' + list.length + ' closed sessions?\n\nThey can still be found by search and shown again; the transcripts are not touched.'))) return;
  for (const it of list) on ? hiddenSet.add(it.key) : hiddenSet.delete(it.key);
  if (on && list.some(it => it.key === selected)) select(null); else { renderList(); renderDetail(true); }
  try {
    await fetch('/api/hide', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ ids: list.map(it => it.key), on }) });
    say(on ? T((list.length > 1 ? list.length + ' sessions masquées' : 'session masquée') + ' — retrouvable par la recherche', (list.length > 1 ? list.length + ' sessions hidden' : 'session hidden') + ' — findable by search') : T('session ré-affichée', 'session shown again'));
  } catch { say(T('échec de la demande', 'request failed')); }
  tick();
}
async function toggleFav(it) {
  const on = !favs.has(it.key); on ? favs.add(it.key) : favs.delete(it.key);
  renderList(); renderDetail();
  try { await post('/api/fav?id=' + it.sessionId + '&on=' + (on ? 1 : 0)); say(on ? T('ajoutée aux favoris', 'added to favourites') : T('retirée des favoris', 'removed from favourites')); } catch { say(T('échec de la demande', 'request failed')); }
}
// ── Pièces jointes : glisser-déposer n'importe où sur la page, coller une capture (Ctrl+V), bouton « Joindre » (téléphone).
// Le fichier part au serveur dès qu'il est déposé (/api/upload, écrit sous ~/.claude/uploads) ; le message envoyé porte
// son CHEMIN (« Capture : "C:\…\x.png" »), que Claude Code lit avec son outil Read. Une seule zone visible à la fois
// (réponse à une session, premier message d'une nouvelle session, message groupé) : c'est elle qui reçoit. ──
const ATT_MAX = 20 * 1024 * 1024, ATT_ACCEPT = 'image/*,.pdf,.txt,.log,.csv,.json,.md';
const attachSets = {};                                   // zone ('reply:<clé>', 'new', 'bc') -> pièces, survit aux re-rendus
const attList = key => attachSets[key] || (attachSets[key] = []);
const attBusy = key => attList(key).some(a => !a.path);
// Texte envoyé : le message, puis un libellé + chemin entre guillemets par pièce (une seule ligne : l'envoi la tape telle quelle).
// Zones de saisie de prompt : textarea de 4 lignes au moins, qui grandit avec le texte (jusqu'à ~12 lignes, puis défile).
// ── Brouillon de réponse : gardé PAR SESSION dans l'onglet (sessionStorage). Il survit au passage à une autre
// session, au re-rendu du détail et au rechargement de la page (nouvelle version déployée, reconnexion) ; il est
// effacé à l'envoi réussi. Calcul pur (testé) sur un stockage passé en argument. ──
function draftSave(store, key, text) {
  try { if (text && text.trim()) store.setItem('cc.draft.' + key, text); else store.removeItem('cc.draft.' + key); } catch { /* stockage plein ou refusé : tant pis */ }
}
function draftLoad(store, key) {
  try { return store.getItem('cc.draft.' + key) || ''; } catch { return ''; }
}
function keepDraft() { const t = $('sendtext'); if (t && t.dataset.key) draftSave(sessionStorage, t.dataset.key, t.value); }
addEventListener('pagehide', keepDraft);
function growArea(t) { if (!t) return; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 300) + 'px'; }
function promptArea(id, rows = 4) {
  const t = el('textarea', 'parea'); t.id = id; t.rows = rows; t.autocomplete = 'off'; t.spellcheck = true;
  t.addEventListener('input', () => growArea(t)); t.addEventListener('keydown', lineKeys); return t;
}
// ── Édition de ligne dans les zones de saisie (comme le terminal de Claude Code) ──
// Ctrl+K coupe jusqu'à la fin de la ligne, Ctrl+U jusqu'au début, Ctrl+Y recolle le dernier texte coupé,
// Ctrl+E va en fin de ligne, Alt+B / Alt+F reculent / avancent d'un mot, Ctrl+_ annule.
// Ctrl+W (couper le mot précédent) n'est pas repris : Chrome le réserve à la fermeture de l'onglet ;
// Ctrl+Retour arrière fait la même chose. Ctrl+A garde son sens navigateur (tout sélectionner).
// Calcul PUR (testé) : ce qu'il faut remplacer et où poser le curseur. L'application passe par execCommand
// pour rester dans l'historique d'annulation du navigateur : Ctrl+Z défait une coupe ou un collage.
function lineEdit(op, v, s, e, kill) {
  const W = c => /[\p{L}\p{N}_]/u.test(c);
  const bol = v.lastIndexOf('\n', s - 1) + 1, eolI = v.indexOf('\n', e), eol = eolI < 0 ? v.length : eolI;
  if ((op === 'killEnd' || op === 'killStart') && s !== e) return { from: s, to: e, insert: '', kill: v.slice(s, e) };
  if (op === 'killEnd') { const to = eol === s && s < v.length ? s + 1 : eol; return to > s ? { from: s, to, insert: '', kill: v.slice(s, to) } : null; }
  if (op === 'killStart') { const from = bol === s && s > 0 ? s - 1 : bol; return from < s ? { from, to: s, insert: '', kill: v.slice(from, s) } : null; }
  if (op === 'yank') return kill ? { from: s, to: e, insert: kill } : null;
  if (op === 'end') return { caret: eol };
  if (op === 'wordBack') { let i = s; while (i > 0 && !W(v[i - 1])) i--; while (i > 0 && W(v[i - 1])) i--; return { caret: i }; }
  if (op === 'wordFwd') { let i = e; while (i < v.length && !W(v[i])) i++; while (i < v.length && W(v[i])) i++; return { caret: i }; }
  return null;
}
function lineKeyOp(e) {
  if (e.metaKey || e.shiftKey && e.key !== '_') return null;
  if (e.ctrlKey && !e.altKey) return { k: 'killEnd', u: 'killStart', y: 'yank', e: 'end', _: 'undo' }[e.key.toLowerCase()] || null;
  if (e.altKey && !e.ctrlKey) return { b: 'wordBack', f: 'wordFwd' }[e.key.toLowerCase()] || null;
  return null;
}
let killed = '';                                          // dernier texte coupé (Ctrl+K / Ctrl+U), recollé par Ctrl+Y
function lineKeys(e) {
  const op = lineKeyOp(e), t = e.currentTarget; if (!op) return;
  e.preventDefault(); e.stopPropagation();
  if (op === 'undo') { document.execCommand('undo'); return; }
  const r = lineEdit(op, t.value, t.selectionStart, t.selectionEnd, killed); if (!r) return;
  if (r.caret != null) { t.setSelectionRange(r.caret, r.caret); return; }
  if (r.kill) killed = r.kill;
  t.setSelectionRange(r.from, r.to);
  const ok = r.insert ? document.execCommand('insertText', false, r.insert) : document.execCommand('delete');
  if (!ok) { t.setRangeText(r.insert, r.from, r.to, 'end'); t.dispatchEvent(new Event('input')); }
}
// Zone vide mais texte collé joint : le message EST ce texte. Sans consigne, la session lisait le fichier puis demandait
// quoi en faire ; on lui dit de le traiter comme s'il avait été tapé (commandes comprises).
function withAttachments(key, text) {
  const list = attList(key).filter(a => a.path), typed = text.trim();
  const refs = list.map(a => (a.pasted ? 'Texte collé (' + a.pasted + (a.pasted > 1 ? ' lignes' : ' ligne') + ')' : a.img ? 'Capture' : 'Fichier') + ' : "' + a.path + '"');
  const pasted = list.filter(a => a.pasted).length;
  const lead = !typed && pasted ? (pasted > 1 ? 'Mon message est dans les textes collés joints : lis-les en entier et fais ce qu’ils demandent, comme si je les avais tapés.'
                                              : 'Mon message est dans le texte collé joint : lis-le en entier et fais ce qu’il demande, comme si je l’avais tapé.') : '';
  return [typed || lead, ...refs].filter(Boolean).join(' ');
}
function clearAttachments(key) { for (const a of attList(key)) if (a.url) URL.revokeObjectURL(a.url); attachSets[key] = []; refreshAttach(key); }
async function uploadFile(key, file, pasted = 0) {
  if (!canWrite) return say(T('lecture seule à distance', 'read-only remotely'));
  if (file.size > ATT_MAX) return say(T('« ' + file.name + ' » non joint : trop gros (20 Mo au plus)', '"' + file.name + '" not attached: too big (20 MB max)'));
  const img = /^image\//.test(file.type);
  const a = { name: file.name || (img ? 'capture.png' : 'fichier'), img, size: file.size, url: img ? URL.createObjectURL(file) : null, path: null, pasted };
  attList(key).push(a); refreshAttach(key);
  try {
    const r = await fetch('/api/upload', { method:'POST', headers:{ 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(a.name) }, body: file });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.path) throw new Error(j.error || 'code ' + r.status);
    a.path = j.path;
    say(pasted ? T('texte collé joint en fichier (' + plural(pasted, 'ligne', 'lignes') + ') : la session le lira en entier, mise en forme comprise — × pour le retirer', 'pasted text attached as a file (' + plural(pasted, 'line', 'lines') + '): the session will read all of it, formatting included — × to remove it')
               : T('« ' + a.name + ' » joint', '"' + a.name + '" attached'));
  } catch (e) {
    const l = attList(key), i = l.indexOf(a); if (i >= 0) l.splice(i, 1); if (a.url) URL.revokeObjectURL(a.url);
    say(T('« ' + a.name + ' » non joint : ', '"' + a.name + '" not attached: ') + (e.message || T('échec de la demande', 'request failed')));
  }
  refreshAttach(key);
}
// Barre des pièces d'une zone : vignettes (retrait possible) + bouton « Joindre ». Se reconstruit à chaque changement.
function attachBar(key) {
  const bar = el('div', 'attach'); bar.dataset.key = key; fillAttach(bar); return bar;
}
function refreshAttach(key) { for (const bar of document.querySelectorAll('.attach')) if (bar.dataset.key === key) fillAttach(bar); }
function fillAttach(bar) {
  const key = bar.dataset.key; bar.replaceChildren();
  for (const a of attList(key)) {
    const chip = el('div', 'achip' + (a.path ? '' : ' up')); chip.title = a.path || T('envoi en cours…', 'uploading…');
    if (a.url) { const im = el('img'); im.src = a.url; im.alt = ''; chip.append(im); } else chip.append(el('span', 'aic', '📄'));
    chip.append(el('span', 'an', a.name), el('span', 'as', a.path ? Math.max(1, Math.round(a.size / 1024)) + T(' Ko', ' KB') : T('envoi…', 'uploading…')));
    const x = el('button', 'ax', '×'); x.title = T('Retirer (le message ne citera pas ce fichier)', 'Remove (the message will not mention this file)');
    x.onclick = () => { const l = attList(key), i = l.indexOf(a); if (i >= 0) l.splice(i, 1); if (a.url) URL.revokeObjectURL(a.url); refreshAttach(key); };
    chip.append(x); bar.append(chip);
  }
  const pick = el('input'); pick.type = 'file'; pick.multiple = true; pick.accept = ATT_ACCEPT; pick.hidden = true;
  pick.onchange = () => { for (const f of pick.files) uploadFile(key, f); pick.value = ''; };
  const b = el('button', 'quick', T('📎 Joindre', '📎 Attach')); b.type = 'button'; b.title = T('Joindre une capture ou un fichier — ou glisse-le sur la page, ou colle une capture (Ctrl+V)', 'Attach a screenshot or a file — or drag it onto the page, or paste a screenshot (Ctrl+V)');
  b.onclick = () => pick.click();
  bar.append(b, pick);
  if (!attList(key).length) bar.append(el('span', 'ahint', T('glisser un fichier ou coller une capture (Ctrl+V)', 'drag a file or paste a screenshot (Ctrl+V)')));
}
const activeAttach = () => { const bar = document.querySelector('#main .attach'); return bar && bar.dataset.key; };
const dropFiles = dt => dt && [...(dt.items || [])].some(i => i.kind === 'file');
document.addEventListener('dragover', e => {
  if (!dropFiles(e.dataTransfer)) return;
  e.preventDefault();                                    // sinon le navigateur ouvre le fichier à la place de la page
  e.dataTransfer.dropEffect = activeAttach() ? 'copy' : 'none';
  document.body.classList.toggle('dropping', !!activeAttach());
});
document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
document.addEventListener('drop', e => {
  if (!dropFiles(e.dataTransfer)) return;
  e.preventDefault(); document.body.classList.remove('dropping');
  const key = activeAttach(); if (!key) return say(T('ouvre une session (Répondre), une nouvelle session ou le message groupé pour joindre un fichier', 'open a session (Reply), a new session or the group message to attach a file'));
  for (const f of e.dataTransfer.files) uploadFile(key, f);
});
// ── Long texte collé ⇒ pièce jointe. Tapé dans la session, un texte part sur UNE ligne (les retours à la ligne
// deviennent des espaces, sinon Entrée enverrait le message trop tôt), est limité à 4 000 caractères et Claude Code le
// lit par morceaux de 1 024 qu'il prend chacun pour un collage distinct. En fichier, la session le lit en entier, mise
// en forme comprise — comme le « [Pasted text #1] » de Claude Code. Calcul PUR (testé) : null = on le colle tel quel. ──
const PASTE_FILE_CHARS = 1000, PASTE_FILE_LINES = 5;
function pastedAsFile(text, now) {
  const t = String(text == null ? '' : text).replace(/\r\n?/g, '\n'), lines = t.replace(/\n+$/, '').split('\n').length;
  if (!t.trim() || t.length < PASTE_FILE_CHARS && lines < PASTE_FILE_LINES) return null;
  let json = false; if (/^\s*[{[]/.test(t)) try { JSON.parse(t); json = true; } catch { /* pas du JSON : texte */ }
  const p = n => String(n).padStart(2, '0');
  return { name: 'texte-colle-' + p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds()) + (json ? '.json' : '.txt'), type: json ? 'application/json' : 'text/plain', lines, text: t };
}
const PASTE_ZONES = { 'sendtext': 'reply:', 'bc-text': 'bc' };   // zone de saisie → zone de pièces jointes qui la porte
document.addEventListener('paste', e => {
  const files = [...((e.clipboardData && e.clipboardData.files) || [])];
  if (!files.length) {
    const zone = e.target && PASTE_ZONES[e.target.id], key = activeAttach();
    if (!zone || !key || !key.startsWith(zone)) return;
    const f = pastedAsFile(e.clipboardData && e.clipboardData.getData('text/plain'), new Date()); if (!f) return;
    e.preventDefault();                                  // long texte collé : pièce jointe, pas une ligne aplatie et tronquée
    uploadFile(key, new File([f.text], f.name, { type: f.type }), f.lines);
    return;
  }
  const key = activeAttach(); if (!key) return;
  e.preventDefault();                                    // une capture collée devient une pièce jointe, pas du texte
  for (const f of files) uploadFile(key, f);
});

let sending = false;
// ── Commandes « / » dans les zones de saisie ──
// Taper « / » en début de zone ouvre le menu des commandes de la session (/api/commands : intégrées, skills et
// commandes du poste, du projet et des plugins activés). ↑ ↓ choisissent, Tab ou Entrée complètent, Échap ferme ;
// Entrée n'envoie que si le nom tapé est exactement celui d'une commande. Sous le menu, ce qu'il faut savoir avant
// d'envoyer : ouvre un menu dans le terminal, ne se rattrape pas, change aussi le réglage par défaut des prochaines
// sessions, ou attend la fin du tour. Le serveur refuse une commande inconnue (faute de frappe : dans le terminal,
// « /mod » + Entrée lance /model) ; « Envoyer quand même » reste possible, la liste pouvant être en retard.
const slashCache = new Map();                             // pid ('' : message groupé) → { at, commands, shortcuts }
async function loadCommands(pid) {
  const k = String(pid || ''), hit = slashCache.get(k), far = /^(.+):(\d+)$/.exec(k);
  if (hit && Date.now() - hit.at < 30000) return hit;
  try {
    const r = await (await fetch(far ? '/api/peer/' + encodeURIComponent(far[1]) + '/commands?pid=' + far[2] : '/api/commands' + (k ? '?pid=' + k : ''))).json();
    const v = { at: Date.now(), commands: r.commands || [], shortcuts: r.shortcuts || [] }; slashCache.set(k, v); return v;
  } catch { return hit || { at: 0, commands: [], shortcuts: [] }; }
}
const knownCommands = pid => (slashCache.get(String(pid || '')) || { commands: [] }).commands;
// Calcul PUR (testé) : ce que la zone contient vu comme une commande. null : pas une commande (texte ordinaire,
// chemin « /api/x »). `typing` : le nom est encore en cours de frappe (rien après lui) ⇒ `items`, les commandes à
// proposer — celles qui commencent par ce qui est tapé, puis celles qui le contiennent.
function slashState(value, commands) {
  const v = String(value || '').replace(/^\s+/, ''), m = /^\/[^\s/]*/.exec(v);
  if (!m || v[m[0].length] === '/' || /[\r\n]/.test(v)) return null;
  const token = m[0].toLowerCase(), rest = v.slice(token.length), typing = rest === '';
  if (token.length > 1 && !/^\/[a-z][a-z0-9_.:-]*$/.test(token)) return null;
  const cmd = commands.find(c => c.name === token) || null, q = token.slice(1);
  const items = !typing ? [] : commands.filter(c => c.name.startsWith(token)).concat(q ? commands.filter(c => !c.name.startsWith(token) && c.name.includes(q)) : []);
  return { token, typing, cmd, items, args: /\S/.test(rest) };
}
// Calcul PUR (testé) : les avertissements d'une commande prête à partir. `busy` : la session travaille ; `many` :
// message groupé.
function slashNotes(st, busy, many) {
  if (!st || st.token.length < 2) return [];
  if (!st.cmd) return st.typing && st.items.length ? [] : [T('commande absente de la liste : elle sera refusée (faute de frappe ?) — tu pourras l’envoyer quand même', 'command not in the list: it will be refused (typo?) — you will be able to send it anyway')];
  const c = st.cmd, dialog = c.dialog === 'always' || (c.dialog === 'bare' && !st.args), out = [];
  if (dialog) out.push(many ? T('ouvre un menu dans le terminal : refusée en message groupé', 'opens a menu in the terminal: refused in a grouped message') : T('ouvre un menu dans le terminal : il se pilote ensuite ici, au pavé de touches', 'opens a menu in the terminal: you then drive it here, with the key pad'));
  if (c.risky) out.push(many ? T('ne se rattrape pas : refusée en message groupé', 'cannot be undone: refused in a grouped message') : T('ne se rattrape pas', 'cannot be undone'));
  if (c.persist && st.args) out.push(T('change aussi le réglage par défaut des prochaines sessions', 'also changes the default for future sessions'));
  if (busy && !c.immediate) out.push(T('session au travail : exécutée à la fin du tour', 'session working: runs at the end of the turn'));
  return out;
}
const SLASH_SRC = { builtin: '', user: T('perso', 'user'), project: T('projet', 'project'), plugin: 'plugin' };
let slashSel = 0, slashShut = null;                       // ligne surlignée ; texte pour lequel le menu a été fermé (Échap)
function slashBox(inp) { let b = inp.parentNode.querySelector('.slashmenu'); if (!b) { b = el('div', 'slashmenu'); b.hidden = true; inp.after(b); } return b; }
function slashComplete(inp, c) {
  inp.value = c.name + (c.args || c.dialog === 'bare' ? ' ' : ''); inp.setSelectionRange(inp.value.length, inp.value.length);
  slashSel = 0; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.focus();
}
// Menu et notes sous la zone. `ctx()` rend { pid, busy, many } au moment du rendu (la session change sous la zone).
function slashRender(inp, ctx) {
  const box = slashBox(inp), c = ctx(), st = slashState(inp.value, knownCommands(c.pid));
  if (!st || slashShut === inp.value) { box.hidden = true; box.replaceChildren(); return null; }
  if (!slashCache.has(String(c.pid || ''))) { loadCommands(c.pid).then(() => { if (document.contains(inp)) slashRender(inp, ctx); }); }
  box.replaceChildren();
  const items = st.items.slice(0, 40); slashSel = Math.max(0, Math.min(slashSel, items.length - 1));
  items.forEach((x, i) => {
    const r = el('div', 'srow' + (i === slashSel ? ' sel' : ''));
    r.append(el('span', 'sn', x.name), el('span', 'sa', x.args || ''), el('span', 'sd', x.desc || ''));
    const tag = [SLASH_SRC[x.source], x.dialog === 'always' ? 'menu' : '', x.risky ? '⚠' : ''].filter(Boolean).join(' · '); if (tag) r.append(el('span', 'st', tag));
    r.onmousedown = e => { e.preventDefault(); slashComplete(inp, x); };
    box.append(r);
  });
  if (st.items.length > items.length) box.append(el('div', 'snote', T('… ' + (st.items.length - items.length) + ' de plus : précise le nom', '… ' + (st.items.length - items.length) + ' more: type more of the name')));
  if (st.cmd && !st.typing) { const r = el('div', 'srow info'); r.append(el('span', 'sn', st.cmd.name), el('span', 'sa', st.cmd.args || ''), el('span', 'sd', st.cmd.desc || '')); box.append(r); }
  if (st.cmd && st.cmd.forms.length && !st.args) for (const f of st.cmd.forms) { const b = el('button', 'quick', f); b.title = T('Sans menu dans le terminal', 'No menu in the terminal'); b.onmousedown = e => { e.preventDefault(); inp.value = f; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.focus(); }; box.append(b); }
  // /model : le choix qui s'arrête à la session, modèle par modèle (le nom tapé en argument, lui, change le défaut).
  if (st.cmd && st.cmd.name === '/model' && !st.args && c.it) for (const e of offeredModels()) {
    const b = el('button', 'quick', T(e.label + ' · cette session', e.label + ' · this session')); b.title = MODEL_HINT();
    b.onmousedown = ev => { ev.preventDefault(); inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true })); setSessionModel(c.it, e.match, e.label); }; box.append(b);
  }
  for (const n of slashNotes(st, c.busy, c.many)) box.append(el('div', 'snote', '⚠ ' + n));
  box.hidden = !box.childNodes.length;
  const cur = box.querySelector('.srow.sel'); if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  return box.hidden ? null : { st, items };
}
function slashAttach(inp, ctx) {
  loadCommands(ctx().pid);
  inp.addEventListener('input', () => { if (slashShut !== inp.value) slashShut = null; slashRender(inp, ctx); });
  inp.addEventListener('blur', () => { const b = slashBox(inp); setTimeout(() => { if (document.activeElement !== inp) b.hidden = true; }, 150); });
  inp.addEventListener('focus', () => slashRender(inp, ctx));
  inp.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || slashBox(inp).hidden) return;
    const open = slashRender(inp, ctx); if (!open) return;
    const pick = open.items[slashSel], stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'Escape') { stop(); slashShut = inp.value; slashRender(inp, ctx); }
    else if (!open.items.length) return;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { stop(); slashSel = (slashSel + (e.key === 'ArrowDown' ? 1 : open.items.length - 1)) % open.items.length; slashRender(inp, ctx); }
    else if (e.key === 'Tab' && !e.shiftKey && pick) { stop(); slashComplete(inp, pick); }
    // Entrée : complète tant que le nom tapé n'est pas exactement une commande (ou qu'une autre ligne est surlignée) ; sinon elle envoie.
    else if (e.key === 'Enter' && !e.shiftKey && pick && (!open.st.cmd || pick.name !== open.st.cmd.name)) { stop(); slashComplete(inp, pick); }
  });
}
// Avant d'envoyer une commande : confirmation de ce qui ne se rattrape pas ou change un réglage durable.
function slashConfirm(text, pid, who) {
  const st = slashState(text, knownCommands(pid)); if (!st || !st.cmd) return true;
  const why = st.cmd.risky ? T('Elle ne se rattrape pas.', 'It cannot be undone.') : st.cmd.persist && st.args ? T('Elle change aussi le réglage par défaut des prochaines sessions.', 'It also changes the default for future sessions.') : '';
  return !why || confirm(T('Envoyer « ' + text.trim() + ' » à ' + who + ' ?\n\n' + (st.cmd.desc ? st.cmd.desc + '. ' : '') + why, 'Send "' + text.trim() + '" to ' + who + '?\n\n' + (st.cmd.desc ? st.cmd.desc + '. ' : '') + why));
}
const unknownAsk = name => confirm(T('« ' + name + ' » n’est pas dans la liste des commandes de cette session (faute de frappe ?).\n\nDans le terminal, Entrée lancerait la commande la plus proche. L’envoyer quand même ?', '"' + name + '" is not in this session’s command list (typo?).\n\nIn the terminal, Enter would run the closest command. Send it anyway?'));
// Boutons de raccourci (ui.shortcuts de config.json, ou ceux par défaut) : une commande toute faite, en un clic.
async function shortcutBar(bar, pid, run) {
  const { shortcuts } = await loadCommands(pid); if (!document.contains(bar)) return;
  bar.replaceChildren();
  for (const s of shortcuts) { const b = el('button', 'quick cmd', s.label); b.title = s.command; b.onclick = () => { if (!s.confirm || confirm(s.confirm)) run(s.command); }; bar.append(b); }
}
async function sendShortcut(it, command) {
  if (sending) return;
  if (link.down) return say(T('serveur injoignable', 'server unreachable'));
  if (!slashConfirm(command, cmdKey(it), '« ' + label(it) + ' »')) return;
  sending = true; say(T('envoi de ' + command + ' à « ' + label(it) + ' »…', 'sending ' + command + ' to "' + label(it) + '"…'));
  try {
    const r = await (await fetch(sx(it, '/api/send?pid=' + it.pid), { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ text: command, force: true }) })).json();
    say(r.error ? T('non envoyé : ', 'not sent: ') + r.error : T(command + (it.status === 'busy' ? ' mis en file pour « ' : ' envoyé à « ') + label(it) + ' »', command + (it.status === 'busy' ? ' queued for "' : ' sent to "') + label(it) + '"'));
  } catch { say(T('échec de la demande', 'request failed')); }
  sending = false; tick();
}
// MODÈLE POUR CETTE SESSION SEULEMENT. « /model <nom> » change aussi le réglage par défaut des prochaines sessions ;
// le serveur rejoue donc le menu /model du terminal (curseur sur le modèle, touche « s ») en relisant l'écran à chaque
// pas (/api/model). Proposés : les modèles de ui.models marqués `offer`, comme dans « Nouvelle session ».
const offeredModels = () => (ui().models || []).filter(e => e.offer !== false);
const MODEL_HINT = () => T('Change le modèle de CETTE session seulement : le réglage par défaut des prochaines sessions ne bouge pas. Session inactive requise ; la conversation est relue par le nouveau modèle (réponse suivante plus lente).', 'Changes the model of THIS session only: the default for future sessions is untouched. The session must be idle; the conversation is re-read by the new model (slower next answer).');
async function setSessionModel(it, match, name) {
  if (!it || it.kind !== 'open' || sending) return;
  if (link.down) return say(T('serveur injoignable', 'server unreachable'));
  sending = true; say(T('« ' + label(it) + ' » : passage sur ' + name + '…', '"' + label(it) + '": switching to ' + name + '…'));
  try {
    const r = await (await fetch('/api/model?pid=' + it.pid, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ model: match }) })).json();
    say(r.error ? T('modèle non changé : ', 'model not changed: ') + r.error : T('« ' + label(it) + ' » passe sur ' + name + ' — cette session seulement', '"' + label(it) + '" now uses ' + name + ' — this session only'));
  } catch { say(T('échec de la demande', 'request failed')); }
  sending = false; tick(); setTimeout(refreshScreen, 400);
}
function modelPicker(live) {
  const s = el('select', 'quick'); s.title = MODEL_HINT();
  const first = el('option', null, T('Modèle (cette session)…', 'Model (this session)…')); first.value = ''; s.append(first);
  for (const e of offeredModels()) { const o = el('option', null, e.label); o.value = e.match; s.append(o); }
  s.onchange = () => { const o = s.selectedOptions[0], v = s.value; s.value = ''; if (v) setSessionModel(live(), v, o.textContent); };
  return s;
}
async function sendReply(force = false) {
  const it = selected && byKey(selected), inp = $('sendtext');
  if (!isLive(it) || !inp || sending) return;
  if (link.down) return say(T('serveur injoignable — le message reste dans la zone, à renvoyer une fois reconnecté', 'server unreachable — the message stays in the box, send it again once reconnected'));
  const akey = 'reply:' + it.key;
  if (attBusy(akey)) return say(T('pièce jointe en cours d’envoi — un instant', 'attachment still uploading — one moment'));
  const text = withAttachments(akey, inp.value); if (!text) return;
  if (!force && !slashConfirm(text, cmdKey(it), '« ' + label(it) + ' »')) return;
  const queued = it.status === 'busy';
  sending = true; inp.disabled = $('sendbtn').disabled = true; say(T((queued ? 'mise en file pour « ' : 'envoi à « ') + label(it) + ' »…', (queued ? 'queueing for "' : 'sending to "') + label(it) + '"…'));
  try {
    const r = await (await fetch(sx(it, '/api/send?pid=' + it.pid), { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(force ? { text, force: true } : { text }) })).json();
    if (r.unknownCommand && !force && unknownAsk(r.unknownCommand)) { sending = false; return sendReply(true); }
    if (r.error) say(T('non envoyé : ', 'not sent: ') + r.error); else { draftSave(sessionStorage, it.key, ''); inp.value = ''; growArea(inp); clearAttachments(akey); say(queued ? T('mis en file pour « ' + label(it) + ' » — Claude Code le prendra dès qu’il peut', 'queued for "' + label(it) + '" — Claude Code will take it as soon as it can') : T('envoyé à « ' + label(it) + ' »', 'sent to "' + label(it) + '"')); }
  } catch { say(T('échec de la demande', 'request failed')); }
  sending = false; tick();
}
// PROPOSITION DE PROMPT : le texte grisé que Claude Code affiche dans l'invite vide après un tour (Tab dans le
// terminal pour l'accepter). Lue par le serveur avec l'écran (/api/screen → suggestion) ; « Lancer » la tape dans la
// session, le serveur revérifiant juste avant qu'elle est ENCORE exactement à l'écran. Coupée à l'écran (« … »), elle
// n'est pas tapée mais acceptée dans le terminal (Tab, Entrée) : le serveur n'en connaît pas la fin. « Modifier » (ou Tab dans la
// zone de réponse vide, ou la touche p) la recopie dans la zone de réponse pour l'ajuster avant d'envoyer.
let suggestion = null, suggestKey = null;
function renderSuggest(it, s) {
  const box = $('suggest'); if (!box) return;
  s = canWrite && (it.status === 'idle' || it.status === 'shell') && s ? s : null;
  if (suggestKey === it.key && box.dataset.sig === (s || '')) return;
  const changed = suggestKey !== it.key || suggestion !== s;
  suggestKey = it.key; suggestion = s; box.dataset.sig = s || '';
  box.replaceChildren(); box.hidden = !s;
  if (changed) renderDetail();                           // placeholder de la zone de réponse
  if (!s) return;
  const cut = s.endsWith('…');
  const go = el('button', 'primary', T('▶ Lancer', '▶ Launch'));
  go.title = cut ? T('Accepte la proposition dans le terminal (Tab puis Entrée) : c’est son texte complet qui part, pas la version coupée', 'Accepts the suggestion in the terminal (Tab then Enter): its full text is sent, not the cut-off version') : T('Tape cette proposition dans la session et l’envoie (revérifiée à l’écran juste avant)', 'Types this suggestion into the session and sends it (checked again on screen just before)');
  go.onclick = () => launchSuggestion(it, s);
  const ed = el('button', null, T('✎ Modifier', '✎ Edit')); ed.title = T('Recopie la proposition dans la zone de réponse  ( p )', 'Copies the suggestion into the reply box  ( p )'); ed.onclick = () => fillSuggestion();
  box.append(el('span', 'slabel', T('💡 Proposition de Claude Code', '💡 Claude Code suggestion')), el('span', 'stext', s), go, ed);
  if (cut) box.append(el('div', 'hint', T('Coupée à l’écran (…) : « Lancer » envoie son texte complet, que la page ne peut pas lire ; « Modifier » pour la réécrire.', 'Cut off on screen (…): "Launch" sends its full text, which the page cannot read; "Edit" to rewrite it.')));
}
function fillSuggestion() {
  const inp = $('sendtext'); if (!inp || inp.disabled || !suggestion) return false;
  inp.value = suggestion.endsWith('…') ? suggestion.slice(0, -1).trimEnd() : suggestion; growArea(inp); inp.focus(); return true;
}
async function launchSuggestion(it, text) {
  if (!text || sending) return;
  sending = true; say(T('lancement de la proposition dans « ' + label(it) + ' »…', 'launching the suggestion in "' + label(it) + '"…'));
  try {
    const r = await (await fetch(sx(it, '/api/send?pid=' + it.pid), { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ text, suggestion: true }) })).json();
    if (r.error) say(T('non lancée : ', 'not launched: ') + r.error); else say(T('proposition lancée dans « ' + label(it) + ' »', 'suggestion launched in "' + label(it) + '"'));
  } catch { say(T('échec de la demande', 'request failed')); }
  sending = false; tick();
}
async function reopen(it) {
  say(T('réouverture de « ' + label(it) + ' »…', 'reopening "' + label(it) + '"…'));
  try { const r = await post('/api/reopen?id=' + it.sessionId); say(r.error ? T('refusé : ', 'refused: ') + r.error : T('nouvel onglet ouvert — la session apparaît dans quelques secondes', 'new tab opened — the session appears in a few seconds')); }
  catch { say(T('échec de la demande', 'request failed')); }
}
const resumeCmd = it => (it.cwd ? 'cd "' + it.cwd + '"; ' : '') + 'claude --dangerously-skip-permissions --resume ' + it.sessionId;
async function copyCmd(it) { try { await navigator.clipboard.writeText(resumeCmd(it)); say(T('commande de reprise copiée', 'resume command copied')); } catch { say(T('copie refusée par le navigateur', 'copy refused by the browser')); } }
const primary = it => { touchRecent(it.key); if (it.kind === 'pass' || it.kind === 'peer') return undefined; return it.kind === 'run' ? (!it.run.running && it.run.sessionId ? openRunConversation(it.run) : undefined) : it.kind === 'open' ? openTab(it) : reopen(it); };
// ── BOUTONS D'ACTION SELON L'ÉTAT. actionsFor est PURE (testée) : ce que la session ou le run permet MAINTENANT.
// Règles : une action qui n'a pas de sens dans cet état est ABSENTE ; une action qui en aura plus tard est GRISÉE avec sa
// raison en infobulle ; il y a UNE seule action principale. ctx : { noTab, canWrite, remote }.
const WRITE_ACTIONS = new Set(['focus', 'reopen', 'fav', 'hide', 'close', 'relaunch', 'resume']);
function actionsFor(it, ctx) {
  const c = ctx || {}, out = [];
  const add = (id, label, title, o) => out.push(Object.assign({ id, label, title: title || '', primary: false, disabled: false, why: null }, o || {}));
  const fav = () => add('fav', it.fav ? T('★ Favori', '★ Favourite') : T('☆ Favori', '☆ Favourite'), (it.fav ? T('Retirer des favoris', 'Remove from favourites') : T('Mettre en favori', 'Add to favourites')) + '  ( f )', { on: !!it.fav });
  let main = null;
  if (it.kind === 'run') {
    const r = it.run || {}, sid = r.sessionId || it.sessionId;
    if (!r.running && sid) { add('resume', T('↻ Reprendre dans un onglet', '↻ Resume in a tab'), 'claude --resume ' + sid + T(' — pour l’inspecter ou la questionner ; le lanceur ne la reprend pas', ' — to inspect or question it; the launcher does not resume it')); main = 'resume'; }
    add('launcher', T('Vue 🤖 Lanceur', '🤖 Launcher view'));
  } else if (it.kind === 'peer') {
    add('copy', T('Copier la commande de reprise', 'Copy the resume command'), it.resumeCmd || '');   // session d'un autre poste : ni onglet, ni fermeture, ni relance d'ici
    fav();
  } else if (it.headless) {
    fav();                                     // automate sans terminal : ni onglet, ni réponse, ni fermeture
  } else if (it.kind === 'open') {
    const idle = it.status === 'idle';
    if (!c.remote) add('focus', T('Afficher l\'onglet', 'Show the tab'), T('Met l’onglet de la session au premier plan  ( Entrée )', 'Brings the session tab to the front  ( Enter )'));
    add('copy', T('Copier la commande de reprise', 'Copy the resume command'), it.resumeCmd || '');
    fav();
    add('fork', T('⑂ Nouvelle session à partir de celle-ci', '⑂ New session from this one'), T('Ouvre une NOUVELLE session qui reprend toute cette conversation (claude --resume … --fork-session) ; celle-ci n’est pas touchée  ( d )', 'Opens a NEW session that carries over this whole conversation (claude --resume … --fork-session); this one is not touched  ( d )'));
    add('close', T('✕ Fermer la session', '✕ Close the session'), T('Quitte la session (/exit) ; la conversation reste reprenable  ( x )', 'Quits the session (/exit); the conversation can still be reopened  ( x )'));
    add('relaunch', T('↻ Fermer et rouvrir', '↻ Close and reopen'), T('Ferme la session (/exit) et la reprend aussitôt dans un nouvel onglet (claude --resume) ; la conversation est conservée', 'Closes the session (/exit) and resumes it right away in a new tab (claude --resume); the conversation is kept'),
      idle ? null : { disabled: true, why: T('possible seulement quand la session est inactive', 'only possible when the session is idle') });
    // Onglet introuvable : la relance devient le geste principal (si elle est possible), sinon on retente l'onglet.
    main = c.noTab && idle ? 'relaunch' : !c.remote ? 'focus' : null;
  } else {
    add('reopen', T('Rouvrir dans un nouvel onglet', 'Reopen in a new tab'), T('Reprend la conversation là où elle s’était arrêtée (claude --resume)  ( Entrée )', 'Picks the conversation up where it left off (claude --resume)  ( Enter )'));
    add('copy', T('Copier la commande de reprise', 'Copy the resume command'), it.resumeCmd || '');
    fav();
    add('fork', T('⑂ Nouvelle session à partir de celle-ci', '⑂ New session from this one'), T('Ouvre une NOUVELLE session qui reprend toute cette conversation (claude --resume … --fork-session)  ( d )', 'Opens a NEW session that carries over this whole conversation (claude --resume … --fork-session)  ( d )'));
    add('hide', it.hidden ? T('Ré-afficher dans la liste', 'Show in the list again') : T('Masquer', 'Hide'), it.hidden ? T('La remet dans « Fermées, reprenables »  ( x )', 'Puts it back in "Closed, reopenable"  ( x )') : T('La retire de la liste ; la recherche la retrouve, le transcript est intact  ( x )', 'Removes it from the list; search still finds it, the transcript is intact  ( x )'));
    main = 'reopen';
  }
  if (c.canWrite === false) for (const a of out) if (WRITE_ACTIONS.has(a.id) && !a.disabled) { a.disabled = true; a.why = T('lecture seule à distance', 'read-only remotely'); }
  const m = out.find(a => a.id === main && !a.disabled);
  if (m) m.primary = true;
  return out;
}
// Ce que fait chaque action. Le gestionnaire relit l'élément par sa clé au clic : la barre survit aux rafraîchissements,
// l'objet qu'elle a vu à sa création peut être périmé.
const ACTION_RUN = {
  focus: it => primary(it), reopen: it => primary(it), resume: it => openRunConversation(it.run), launcher: () => openLauncher(),
  copy: it => copyCmd(it), fav: it => toggleFav(it), hide: it => setHidden([it], !it.hidden), close: it => closeSession(it), relaunch: it => relaunch(it),
  fork: it => openNew({ sessionId: it.sessionId, title: it.title, cwd: it.cwd, tags: it.tags }),
};
// Barre d'actions persistante : posée dans `holder` (hors de l'en-tête reconstruit toutes les 2 s) et refaite SEULEMENT
// quand la liste change (actions, libellés, principale, grisées) — le survol, l'infobulle et le focus restent.
function actionBar(holder, it, list) {
  if (!holder) return;
  const sig = it.key + '|' + list.map(a => [a.id, a.label, a.title, a.primary ? 1 : 0, a.disabled ? 1 : 0, a.why || ''].join('~')).join('|');
  if (holder.dataset.sig === sig) return;
  holder.dataset.sig = sig;
  const key = it.key, box = el('div', 'actions');
  for (const a of list) {
    const b = el('button', a.primary ? 'primary' : null, a.label);
    b.dataset.act = a.id;
    b.title = a.disabled && a.why ? a.why : a.title;
    b.disabled = a.disabled;
    if (a.id === 'fav' && a.on) b.style.color = 'var(--fav)';
    b.onclick = () => { const cur = byKey(key) || it; const f = ACTION_RUN[a.id]; if (f) f(cur.kind === 'run' && it.kind === 'run' ? pickRun(cur) : cur); };
    box.append(b);
  }
  holder.replaceChildren(box);
}
const actionCtx = it => ({ noTab: noTab.has(it.key), canWrite, remote: !!REMOTE });

// ── Recherche dans les conversations ──
// Dès 3 caractères dans la recherche, le panneau de droite liste les passages des conversations (index plein
// texte côté serveur) ; la barre latérale continue de filtrer les sessions comme avant.
let findMode = false, findQ = '', findRes = null, findTimer = null, findSeq = 0;
function scheduleFind() {
  // Des filtres de tags seuls (« domaine:telephonie ») ne filtrent que la liste ; avec des mots (« domaine:telephonie sms »),
  // ils partent aussi au serveur, qui ne cherche les mots que dans les conversations portant ces tags.
  clearTimeout(findTimer); const full = $('q').value.trim().split(/\s+/).filter(t => t && !isStateToken(t)).join(' '), words = full.split(/\s+/).filter(t => !isTagToken(t)).join(' ');
  const q = words.length < 3 ? '' : full;
  if (q.length < 3) { const was = findMode; findMode = false; findRes = null; findQ = ''; if (was) renderDetail(true); return; }
  findTimer = setTimeout(() => runFind(q), 350);
}
async function runFind(q) {
  const seq = ++findSeq;
  if (!findMode) { findMode = true; newMode = false; bcMode = false; boardMode = false; launchMode = false; chatsMode = false; findRes = null; findQ = q; renderDetail(true); }
  try {
    const r = await (await fetch('/api/find?q=' + encodeURIComponent(q), { cache:'no-store' })).json();
    if (seq !== findSeq) return;                   // une frappe plus récente a relancé la recherche
    findRes = r; findQ = q; if (findMode) renderDetail(true);
  } catch { if (seq === findSeq) say(T('recherche impossible', 'search failed')); }
}
// Surligne les mots cherchés, sans tenir compte des accents (le texte normalisé garde la longueur du texte).
function highlight(text, q) {
  const span = el('span'); const nt = norm(text);
  const toks = norm(q).split(/\s+/).filter(t => t.length >= 2);
  if (nt.length !== text.length || !toks.length) { span.textContent = text; return span; }
  const marks = [];
  for (const t of toks) { let i = nt.indexOf(t); while (i >= 0) { marks.push([i, i + t.length]); i = nt.indexOf(t, i + t.length); } }
  marks.sort((a, b) => a[0] - b[0]); let at = 0;
  for (const [s, e] of marks) { if (s < at) continue; span.append(text.slice(at, s), el('mark', null, text.slice(s, e))); at = e; }
  span.append(text.slice(at)); return span;
}
function snipEl(s, q) {
  const d = el('div', 'snip');
  d.append(el('span', 'who', (s.role === 'user' ? T('🧑 toi', '🧑 you') : '🤖 Claude') + (s.at ? ' · ' + new Date(s.at).toLocaleString(LOCALE, { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '')), highlight(s.text, q));
  return d;
}
function renderFind() {
  detailKey = '__find__'; const main = $('main'); main.replaceChildren();
  main.append(el('div', 'dtitle', T('Dans les conversations — « ' + findQ + ' »', 'In conversations — "' + findQ + '"')));
  const r = findRes;
  if (!r) { main.append(el('div', 'meta', T('recherche…', 'searching…'))); return; }
  main.append(el('div', 'meta', T((r.sessions || 0) + ' session' + (r.sessions > 1 ? 's' : '') + ' · ' + (r.total || 0) + ' message' + (r.total > 1 ? 's' : '') + ' · ' + r.ms + ' ms · ' + r.indexed + ' transcripts indexés' + (r.indexing ? ' — indexation en cours, résultats partiels' : '') + (r.sessions > r.hits.length ? ' · ' + r.hits.length + ' plus récentes affichées' : ''), (r.sessions || 0) + ' session' + (r.sessions > 1 ? 's' : '') + ' · ' + (r.total || 0) + ' message' + (r.total > 1 ? 's' : '') + ' · ' + r.ms + ' ms · ' + r.indexed + ' transcripts indexed' + (r.indexing ? ' — indexing in progress, partial results' : '') + (r.sessions > r.hits.length ? ' · ' + r.hits.length + ' most recent shown' : ''))));
  if (!r.hits.length) { main.append(el('h2', null, T('Aucun message ne contient tous ces mots', 'No message contains all these words'))); return; }
  const box = el('div'); box.style.marginTop = '16px';
  for (const h of r.hits) {
    const it = byKey(h.sessionId); const st = it ? it.state : 'closed';
    const c = el('div', 'fhit ' + st + (it ? ' go' : ''));
    const t = el('div', 'ft'); t.append(el('span', 'dot'), el('span', null, (it ? label(it) : h.title) || h.sessionId.slice(0, 8)),
      el('span', 'n', h.count + ' message' + (h.count > 1 ? 's' : '') + ' · ' + LABEL[st] + (it ? '' : T(', hors liste', ', not in the list'))));
    if (!it && !h.title) t.children[1].textContent = T('session sans titre (lancement automatique) · ', 'untitled session (automatic launch) · ') + h.sessionId.slice(0, 8);
    if (it && it.hidden) t.children[1].append(el('span', 'tag hid', T('masquée', 'hidden')));
    c.append(t);
    if (h.cwd) c.append(el('div', 'meta', short(h.cwd)));
    for (const s of h.snippets) c.append(snipEl(s, findQ));
    if (it) { c.title = T('Ouvrir le détail de la session', 'Open the session details'); c.onclick = () => select(it.key, true); }
    else {
      const a = el('div', 'actions');
      const b1 = el('button', null, T('Rouvrir dans un nouvel onglet', 'Reopen in a new tab')); b1.onclick = () => reopen({ sessionId: h.sessionId, title: h.title });
      const fake = { sessionId: h.sessionId, cwd: h.cwd };
      const b2 = el('button', null, T('Copier la commande de reprise', 'Copy the resume command')); b2.title = resumeCmd(fake); b2.onclick = () => copyCmd(fake);
      a.append(b1, b2); c.append(a);
    }
    box.append(c);
  }
  main.append(box);
}

// ── Nouvelle session ──
// newFork : session source quand on part d'une session existante ({ sessionId, title, cwd }) — la nouvelle session reprend
// toute sa conversation (claude --resume <id> --fork-session, nouvel identifiant, la source n'est pas touchée).
// newPrefill : formulaire prérempli par une autre vue ({ title, prompt, tags }) — « Reprendre en session » d'une livraison
// refusée. Rien n'est lancé : on relit, on modifie, on choisit le dossier, puis « Lancer ».
let newMode = false, launching = false, newFork = null, newPrefill = null;
function openNew(fork = null, prefill = null) { newFork = fork; newPrefill = prefill; newTags = prefill ? prefill.tags.map(t => ({ ...t })) : forkTags(fork); findMode = false; bcMode = false; boardMode = false; launchMode = false; chatsMode = false; selected = null; sessionStorage.removeItem('cc.sel'); newMode = true; setPane(true); renderList(); renderDetail(true); }
function closeNew() { if (newPrefill && newPrefill.draft) clearAttachments('new'); newMode = false; newPrefill = null; setPane(false); renderList(); renderDetail(true); }
// ── Brouillons : le formulaire enregistré sans être lancé (serveur : drafts.ts, gardé sur le poste) ──
// Rouvert, il préremplit tout ; « Lancer » refait les contrôles du lancement et supprime le brouillon s'il réussit.
function draftTitle(d) {
  const line = (d.prompt || '').split('\n').map(x => x.trim()).find(Boolean);
  return line ? (line.length > 90 ? line.slice(0, 90) + '…' : line) : d.forkFrom ? '⑂ ' + (d.forkTitle || d.forkFrom.slice(0, 8)) : T('(sans premier message)', '(no first message)');
}
const draftHay = d => [d.prompt, d.cwd, d.branch, d.forkTitle, ...d.tags.map(t => t.v)].join(' ');
function openDraft(d) {
  clearAttachments('new');
  attList('new').push(...d.attachments.map(a => ({ ...a, url: null })));
  const fork = d.forkFrom ? { sessionId: d.forkFrom, title: d.forkTitle, cwd: d.cwd } : null;
  openNew(fork, { title: draftTitle(d), prompt: d.prompt, tags: d.tags, draft: d });
}
async function saveDraft() {
  const cwd = $('nf-cwd'), pr = $('nf-prompt'), mo = $('nf-model'), br = $('nf-branch');
  if (!pr || launching) return;
  if (attBusy('new')) return say(T('pièce jointe en cours d’envoi — un instant', 'attachment still uploading — one moment'));
  if (!addNewTag()) return;
  const draft = newPrefill && newPrefill.draft;
  const body = { id: draft ? draft.id : '', cwd: cwd && !cwd.disabled ? cwd.value : draft ? draft.cwd : '', prompt: pr.value, model: mo.value.trim(), branch: br.value.trim(),
    forkFrom: newFork ? newFork.sessionId : '', forkTitle: newFork ? newFork.title || '' : '', tags: newTags,
    attachments: attList('new').filter(a => a.path).map(a => ({ name: a.name, path: a.path, img: !!a.img, size: a.size || 0, pasted: a.pasted || 0 })) };
  launching = true; say(T('enregistrement du brouillon…', 'saving the draft…'));
  try {
    const r = await (await fetch('/api/draft-save', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(body) })).json();
    launching = false;
    if (r.error) return say(T('brouillon non enregistré : ', 'draft not saved: ') + r.error);
    clearAttachments('new'); say(draft ? T('brouillon mis à jour', 'draft updated') : T('brouillon enregistré — il t’attend en tête de liste', 'draft saved — it waits at the top of the list'));
    newPrefill = null; closeNew(); tick(); return;
  } catch { say(T('échec de la demande', 'request failed')); }
  launching = false;
}
async function deleteDraft() {
  const draft = newPrefill && newPrefill.draft; if (!draft || launching) return;
  if (!confirm(T('Supprimer ce brouillon ?\n\n', 'Delete this draft?\n\n') + draftTitle(draft))) return;
  try {
    const r = await (await fetch('/api/draft-delete', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ id: draft.id }) })).json();
    say(r.removed ? T('brouillon supprimé', 'draft deleted') : T('brouillon déjà parti (lancé ou supprimé ailleurs)', 'draft already gone (launched or deleted elsewhere)'));
    closeNew(); tick();
  } catch { say(T('échec de la demande', 'request failed')); }
}

// ── Message à plusieurs sessions (✉) : même texte tapé dans chaque session cochée — seulement les inactives ou
// celles qui attendent une commande en arrière-plan (invite libre) ; le serveur revérifie chacune. ──
let bcMode = false, bcSending = false;
const bcPick = new Set();
const bcEligible = () => allItems().filter(it => it.kind === 'open' && !it.headless && (it.status === 'idle' || it.status === 'shell'));
function openBc() { findMode = false; newMode = false; boardMode = false; launchMode = false; chatsMode = false; selected = null; sessionStorage.removeItem('cc.sel'); bcMode = true; setPane(true); renderList(); renderDetail(true); }
function closeBc() { bcMode = false; setPane(false); renderDetail(true); }
function renderBc() {
  detailKey = '__bc__'; const main = $('main'); main.replaceChildren();
  main.append(el('div', 'dtitle', T('Écrire à plusieurs sessions', 'Write to several sessions')),
              el('div', 'meta', T('Le même message est tapé dans chaque session cochée, comme « Répondre » : seulement si elle est inactive et son invite vide (sinon elle est sautée). Chaque envoi est journalisé.', 'The same message is typed into each ticked session, like "Reply": only if it is idle and its prompt is empty (otherwise it is skipped). Each send is logged.')));
  const f = el('div'); f.id = 'bcform';
  const tx = promptArea('bc-text'); tx.autocomplete = 'off'; tx.placeholder = T('ex. « rebase sur origin/master et dis-moi où tu en es »', 'e.g. "rebase on origin/master and tell me where you are"');
  const list = el('div', 'bclist'); list.id = 'bc-list';
  const quick = el('div', 'actions');
  const qa = el('button', null, T('Toutes', 'All')); qa.onclick = () => { bcEligible().forEach(it => bcPick.add(it.key)); fillBc(); };
  const qn = el('button', null, T('Aucune', 'None')); qn.onclick = () => { bcPick.clear(); fillBc(); };
  const qc = el('button', null, T('Celles qui peuvent se fermer', 'Those that can be closed')); qc.onclick = () => { bcPick.clear(); bcEligible().filter(closable).forEach(it => bcPick.add(it.key)); fillBc(); };
  quick.append(qa, qn, qc);
  // Commandes « / » : même menu que « Répondre » ; un raccourci pré-remplit le message (les sessions se cochent à part).
  slashAttach(tx, () => ({ pid: '', busy: false, many: true }));
  const scb = el('span', 'shortcuts'); quick.append(scb); shortcutBar(scb, '', c => { tx.value = c; growArea(tx); tx.focus(); });
  const go = el('button', 'primary', T('Envoyer', 'Send')); go.id = 'bc-go'; go.onclick = () => sendBc();
  const cancel = el('button', null, T('Fermer', 'Close')); cancel.onclick = () => closeBc();
  const acts = el('div', 'actions'); acts.append(go, cancel);
  const pick = el('div'); pick.append(quick, list);
  f.append(el('label', null, 'Message'), tx, el('label', null, T('Pièces jointes', 'Attachments')), attachBar('bc'), el('label', null, 'Sessions'), pick, acts, el('div', 'hint', T('Ctrl+Entrée envoie · Échap ferme', 'Ctrl+Enter sends · Esc closes')));
  main.append(f); fillBc(); tx.focus();
}
function fillBc() {
  const list = $('bc-list'); if (!list) return; list.replaceChildren();
  const el2 = bcEligible().sort((a, b) => b.since - a.since);
  for (const k of [...bcPick]) if (!el2.some(it => it.key === k)) bcPick.delete(k);
  if (!el2.length) { list.append(el('div', 'empty', T('Aucune session inactive pour l’instant.', 'No idle session for now.'))); }
  for (const it of el2) {
    const lab = el('label'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = bcPick.has(it.key); cb.onchange = () => cb.checked ? bcPick.add(it.key) : bcPick.delete(it.key);
    lab.append(cb, el('span', null, label(it)), el('span', 'rm', LABEL[it.state] + ' · ' + ago(data.now - it.since))); list.append(lab);
  }
  const go = $('bc-go'); if (go) go.textContent = T('Envoyer à ' + plural(bcPick.size, 'session', 'sessions'), 'Send to ' + plural(bcPick.size, 'session', 'sessions'));
  list.onchange = () => { if ($('bc-go')) $('bc-go').textContent = T('Envoyer à ' + plural(bcPick.size, 'session', 'sessions'), 'Send to ' + plural(bcPick.size, 'session', 'sessions')); };
}
async function sendBc(force = false) {
  const tx = $('bc-text'); if (!tx || bcSending) return;
  if (attBusy('bc')) return say(T('pièce jointe en cours d’envoi — un instant', 'attachment still uploading — one moment'));
  const text = withAttachments('bc', tx.value); const targets = bcEligible().filter(it => bcPick.has(it.key));
  if (!text) return say(T('message vide', 'empty message')); if (!targets.length) return say(T('aucune session cochée', 'no session ticked'));
  if (!force && !confirm(T('Taper « ' + text + ' » dans ' + plural(targets.length, 'session', 'sessions') + ' ?\n\n', 'Type "' + text + '" into ' + plural(targets.length, 'session', 'sessions') + '?\n\n') + targets.map(it => '• ' + label(it)).join('\n'))) return;
  bcSending = true; $('bc-go').disabled = true; say(T('envoi à ' + plural(targets.length, 'session', 'sessions') + '…', 'sending to ' + plural(targets.length, 'session', 'sessions') + '…'));
  try {
    const r = await (await fetch('/api/send-many', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ pids: targets.map(it => it.pid), text, force }) })).json();
    const unk = r.results.find(x => x.unknownCommand);
    if (unk && !force && unknownAsk(unk.unknownCommand)) { bcSending = false; return sendBc(true); }
    const ok = r.results.filter(x => !x.error), ko = r.results.filter(x => x.error);
    say(T(plural(ok.length, 'envoi', 'envois'), plural(ok.length, 'send', 'sends')) + (ko.length ? T(' · ' + ko.length + ' sauté(s) : ', ' · ' + ko.length + ' skipped: ') + ko.map(x => (x.title || x.pid) + ' (' + x.error + ')').join(', ') : ''));
    if (!ko.length) { tx.value = ''; growArea(tx); bcPick.clear(); clearAttachments('bc'); }
  } catch { say(T('échec de la demande', 'request failed')); }
  bcSending = false; if ($('bc-go')) $('bc-go').disabled = false; tick();
}
// ── Tags choisis à la création : posés comme une correction à la main (lot 3), avant le démarrage de la session ──
// Domaine et outil : listes fermées (/api/tag-vocab) ; sinon le mot devient une fonction (« Power Dial » → power-dial).
let newTags = [];
const isFonction = v => /^[a-z0-9]+(-[a-z0-9]+){0,4}$/.test(v) && v.length >= 3 && v.length <= 40;
// Une session dérivée repart du même sujet : ses domaine / outil / fonction sont proposés (retirables d'un clic).
const forkTags = fork => fork && fork.tags ? fork.tags.filter(t => TAG_EDITABLE.includes(t.axis)).map(t => ({ axis: t.axis, v: t.v })).slice(0, 8) : [];
function parseNewTag(text, vocab) {
  const s = text.trim(); if (!s) return null;
  const m = /^(domaine|outil|fonction)\s*:\s*(.+)$/i.exec(s);
  const axis = m ? m[1].toLowerCase() : null, raw = m ? m[2].trim() : s;
  const lists = { domaine: vocab.domaines || [], outil: vocab.outils || [] };
  for (const a of ['domaine', 'outil']) {
    if (axis && axis !== a) continue;
    const v = lists[a].find(x => tagSlug(x) === tagSlug(raw)); if (v) return { axis: a, v };
    if (axis) return { error: T(a + ' hors liste : ' + raw, a + ' not in the list: ' + raw) };
  }
  const f = tagSlug(raw);
  return isFonction(f) ? { axis: 'fonction', v: f } : { error: T('fonction : 1 à 5 mots, 3 à 40 caractères', 'fonction: 1 to 5 words, 3 to 40 characters') };
}
function addNewTag() {
  const ti = $('nf-tag'); if (!ti) return true;
  const t = parseNewTag(ti.value, tagVocab || {}); if (!t) return true;
  if (t.error) { say(t.error); return false; }
  if (!newTags.some(x => x.axis === t.axis && x.v === t.v)) { if (newTags.length >= 8) { say(T('8 tags au plus', '8 tags at most')); return false; } newTags.push(t); }
  ti.value = ''; drawNewTags(); return true;
}
function drawNewTags() {
  const box = $('nf-tags'), ti = $('nf-tag'); if (!box || !ti) return;
  box.replaceChildren();
  for (const t of newTags) {
    const c = el('span', 'chip ' + t.axis, t.v + ' ×'); c.title = T(t.axis + ' : ' + t.v + '\nclic : retirer', t.axis + ': ' + t.v + '\nclick: remove');
    c.onclick = () => { newTags = newTags.filter(x => x !== t); drawNewTags(); ti.focus(); };
    box.append(c);
  }
  box.append(ti);
  ti.placeholder = newTags.length ? '' : T('facultatif — ex. Téléphonie, contact-center, power-dial', 'optional — e.g. Téléphonie, contact-center, power-dial');
}
function newTagOptions(dl) {
  const v = tagVocab || {}, used = new Set(newTags.map(t => t.axis + ':' + t.v)), fn = new Map();
  for (const it of allItems()) for (const t of it.tags || []) if (t.axis === 'fonction' && isFonction(t.v)) fn.set(t.v, (fn.get(t.v) || 0) + 1);
  const opts = [...(v.domaines || []).map(x => ['domaine', x]), ...(v.outils || []).map(x => ['outil', x]),
                ...[...fn].sort((a, b) => b[1] - a[1]).slice(0, 300).map(([x]) => ['fonction', x])];
  dl.replaceChildren();
  for (const [a, x] of opts) { if (used.has(a + ':' + x)) continue; const o = el('option'); o.value = a + ':' + x; dl.append(o); }
}
function renderNew() {
  detailKey = '__new__'; const main = $('main'); main.replaceChildren();
  const fork = newFork, draft = newPrefill && newPrefill.draft;
  if (draft) main.append(el('div', 'dtitle', T('Brouillon — ', 'Draft — ') + newPrefill.title),
                         el('div', 'meta', T('Enregistré il y a ' + ago(Date.now() - draft.updatedAt) + '. Rien n’est lancé tant que tu ne cliques pas « Lancer » : la session s’ouvre alors dans un nouvel onglet de Windows Terminal et le brouillon disparaît.', 'Saved ' + ago(Date.now() - draft.updatedAt) + ' ago. Nothing is launched until you click "Launch": the session then opens in a new Windows Terminal tab and the draft goes away.')));
  else main.append(el('div', 'dtitle', T(fork ? 'Nouvelle session à partir de « ' + (fork.title || fork.sessionId.slice(0, 8)) + ' »' : newPrefill ? 'Nouvelle session — ' + newPrefill.title : 'Nouvelle session', fork ? 'New session from "' + (fork.title || fork.sessionId.slice(0, 8)) + '"' : newPrefill ? 'New session — ' + newPrefill.title : 'New session')),
              el('div', 'meta', T('S’ouvre dans un nouvel onglet de la fenêtre Windows Terminal la plus récente, puis apparaît dans la liste.', 'Opens in a new tab of the most recent Windows Terminal window, then appears in the list.')));
  if (fork) main.append(el('div', 'banner', T('La nouvelle session repart de TOUTE la conversation de « ' + (fork.title || fork.sessionId) + ' » (claude --resume ' + fork.sessionId.slice(0, 8) + '… --fork-session) : elle a son propre identifiant, la session d’origine continue de son côté sans rien voir de la suite. Le contexte hérité compte dans la fenêtre de la nouvelle session.', 'The new session starts from the WHOLE conversation of "' + (fork.title || fork.sessionId) + '" (claude --resume ' + fork.sessionId.slice(0, 8) + '… --fork-session): it has its own id, the original session goes on by itself without seeing what follows. The inherited context counts in the context window of the new session.')));
  const f = el('div'); f.id = 'newform';
  const cwd = el('select'); cwd.id = 'nf-cwd'; cwd.append(el('option', null, T('chargement des dossiers…', 'loading folders…'))); cwd.disabled = true;
  if (newPrefill && !draft) main.append(el('div', 'banner', T('Premier message prérempli par le lanceur : relis-le, ajuste-le, choisis le dossier du dépôt de la PR, puis « Lancer ». Rien n’est lancé ni mergé d’ici.', 'First message prefilled by the launcher: read it, adjust it, choose the folder of the PR repository, then "Launch". Nothing is launched or merged from here.')));
  const pr = el('textarea'); pr.id = 'nf-prompt'; pr.maxLength = 20000; pr.spellcheck = true;
  if (newPrefill) { pr.value = newPrefill.prompt; pr.rows = 8; }
  if (draft && draft.attachments.length && Date.now() - draft.updatedAt > 25 * 864e5) say(T('brouillon de plus de 25 jours : ses pièces jointes sont purgées du poste au bout de 30', 'draft older than 25 days: its attachments are purged from the machine after 30'));
  pr.placeholder = T('Facultatif — ex. « /cadrage HD-123456 » ou « regarde pourquoi … »', 'Optional — e.g. "/code-review" or "look at why …"');
  // Modèle : un groupe de boutons (un seul actif) plutôt qu'une liste ; « Autre… » ouvre la saisie libre pour un
  // identifiant complet (ex. claude-opus-5-5[1m]). Le champ #nf-model reste la valeur envoyée par launchNew.
  const mo = el('input'); mo.id = 'nf-model'; mo.autocomplete = 'off'; mo.spellcheck = false;
  mo.placeholder = T('identifiant complet — ex. claude-opus-5-5[1m]', 'full id — e.g. claude-opus-5-5[1m]'); mo.value = draft ? draft.model : localStorage.getItem('cc.newmodel') || '';
  // Modèles proposés : ceux de ui.models marqués `offer` (table du poste, ou table par défaut), avec leur coût relatif.
  const MODELS = [['', T('Par défaut', 'Default'), T('celui de ta config', 'the one in your config')],
    ...(ui().models || []).filter(e => e.offer !== false).map(e => [e.match, e.label + (e.cost !== 1 ? ' ' + costFactor(e.cost) : ''), modelBadge(e.match).title.split('\n').slice(1, -1).join('\n'), e])];
  const costNote = el('div', 'nf-cost'); costNote.hidden = true;
  const mg = el('div', 'nf-seg'); mg.setAttribute('role', 'radiogroup'); mg.setAttribute('aria-label', T('Modèle', 'Model'));
  const segs = [];
  const pickModel = (key, focus) => {
    const other = key === '*';
    if (!other) mo.value = key; else if (MODELS.some(([k]) => k && k === mo.value)) mo.value = '';   // « Autre… » part d'un champ vide
    for (const b of segs) { const on = b.dataset.k === key; b.classList.toggle('sel', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; }
    mo.hidden = !other; if (other && focus) mo.focus();
    // Modèle plus cher que la référence : le dire au moment du choix (« Autre… » : d'après l'identifiant saisi).
    const c = modelCost(mo.value);
    costNote.hidden = !(c && c.cost >= 1.2);
    if (!costNote.hidden) costNote.textContent = T('💰 ' + c.label + ' coûte ' + costFactor(c.cost) + ' par rapport à ' + costRef() + ' — et épuise le quota ' + costFactor(c.cost) + ' plus vite. À réserver aux tâches qui le justifient.', '💰 ' + c.label + ' costs ' + costFactor(c.cost) + ' compared with ' + costRef() + ' — and uses up the quota ' + costFactor(c.cost) + ' faster. Keep it for tasks that need it.');
  };
  mo.addEventListener('input', () => { const c = modelCost(mo.value); costNote.hidden = !(c && c.cost >= 1.2); if (!costNote.hidden) costNote.textContent = T('💰 ' + c.label + ' coûte ' + costFactor(c.cost) + ' par rapport à ' + costRef() + '.', '💰 ' + c.label + ' costs ' + costFactor(c.cost) + ' compared with ' + costRef() + '.'); });
  for (const [k, lab, tip, e] of [...MODELS, ['*', T('Autre…', 'Other…'), T('saisir un identifiant de modèle complet', 'type a full model id')]]) {
    const b = el('button', e && e.cost >= 1.2 ? 'pricey' : null, lab); b.type = 'button'; b.dataset.k = k; b.setAttribute('role', 'radio'); if (tip) b.title = tip;
    b.onclick = () => pickModel(k, true);
    b.onkeydown = e => {                                    // flèches : comme un groupe de radios
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d) return; e.preventDefault(); const n = segs[(segs.indexOf(b) + d + segs.length) % segs.length]; pickModel(n.dataset.k, false); n.focus();
    };
    segs.push(b); mg.append(b);
  }
  pickModel(MODELS.some(([k]) => k === mo.value) ? mo.value : '*', false);
  const mbox = el('div', 'nf-model'); mbox.append(mg, mo, costNote);
  const br = el('input'); br.id = 'nf-branch'; br.autocomplete = 'off'; br.spellcheck = false;
  br.placeholder = T('facultatif — ex. feat/ma-branche : worktree neuf sur origin/master', 'optional — e.g. feat/my-branch: new worktree on origin/master');
  if (draft) br.value = draft.branch;
  const tbox = el('div', 'nf-tags'); tbox.id = 'nf-tags';
  const ti = el('input'); ti.id = 'nf-tag'; ti.setAttribute('list', 'nf-tagopts'); ti.autocomplete = 'off'; ti.spellcheck = false;
  const tdl = el('datalist'); tdl.id = 'nf-tagopts';
  ti.onfocus = () => { loadTagVocab().then(() => newTagOptions(tdl)); };
  ti.onkeydown = e => {
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); e.stopPropagation(); if (addNewTag()) newTagOptions(tdl); }
    else if (e.key === 'Backspace' && !ti.value && newTags.length) { newTags.pop(); drawNewTags(); newTagOptions(tdl); }
  };
  // Choix dans la liste des propositions : ajouté tout de suite (Chrome : inputType « insertReplacementText » ou absent).
  ti.oninput = e => { if ((!e.inputType || e.inputType === 'insertReplacementText') && ti.value) { if (addNewTag()) newTagOptions(tdl); } };
  tbox.onclick = e => { if (e.target === tbox) ti.focus(); };
  tbox.append(ti);                   // drawNewTags le retrouve par son id et place les puces devant
  const go = el('button', 'primary', T('Lancer', 'Launch')); go.id = 'nf-go'; go.onclick = () => launchNew();
  const save = el('button', null, draft ? T('💾 Mettre à jour le brouillon', '💾 Update the draft') : T('💾 Enregistrer en brouillon', '💾 Save as draft')); save.id = 'nf-save';
  save.title = T('Garder ce formulaire sans lancer la session : il t’attend en tête de liste  ( Ctrl+S )', 'Keep this form without launching the session: it waits at the top of the list  ( Ctrl+S )');
  save.onclick = () => saveDraft();
  const cancel = el('button', null, draft ? T('Fermer', 'Close') : T('Annuler', 'Cancel')); cancel.onclick = () => closeNew();
  const acts = el('div', 'actions'); acts.append(go, save, cancel);
  if (draft) { const del = el('button', 'danger', T('Supprimer le brouillon', 'Delete the draft')); del.onclick = () => deleteDraft(); acts.append(del); }
  const trust = el('div', 'hint warn'); trust.id = 'nf-trust'; trust.hidden = true;
  br.addEventListener('input', () => trustHint());
  f.append(el('label', null, T('Dossier', 'Folder')), cwd, trust,
           el('div', 'hint', T('Dossiers où une session a tourné récemment, plus ceux déclarés (★) dans newSession.folders de ~/.claude/sessions-desk/config.json — un dossier absent s’y ajoute.', 'Folders where a session ran recently, plus those declared (★) in newSession.folders of ~/.claude/sessions-desk/config.json — add a missing folder there.')),
           el('label', null, T('Premier message', 'First message')), pr,
           el('div', 'hint', T('Envoyé tel quel à la session dès son démarrage. Vide : la session attend ta première demande.', 'Sent as is to the session as soon as it starts. Empty: the session waits for your first request.')),
           el('label', null, T('Pièces jointes', 'Attachments')), attachBar('new'),
           el('label', null, 'Tags'), tbox, tdl,
           el('div', 'hint', T('Entrée ajoute · clic sur un tag le retire. Domaine et outil : listes fermées ; sinon le mot devient une fonction (power-dial). Posés comme une correction à la main : l’étiqueteur ne les retire jamais.', 'Enter adds · click a tag to remove it. Domain and tool: fixed lists; otherwise the word becomes a function (power-dial). Set as a manual correction: the tagger never removes them.')),
           el('label', null, T('Modèle', 'Model')), mbox,
           el('label', null, T('Branche neuve', 'New branch')), br,
           el('div', 'hint', T('Remplie : l’onglet récupère origin/master, crée la branche dans un worktree neuf (.claude\\worktrees\\<dernier segment>) et y lance la session, au même sous-dossier. Vide : session dans le dossier choisi.', 'Filled: the tab fetches origin/master, creates the branch in a new worktree (.claude\\worktrees\\<last segment>) and starts the session there, in the same subfolder. Empty: session in the chosen folder.')),
           acts, el('div', 'hint', T('Ctrl+Entrée lance · Ctrl+S enregistre en brouillon · Échap annule', 'Ctrl+Enter launches · Ctrl+S saves as draft · Esc cancels')));
  main.append(f); drawNewTags(); loadTagVocab(); pr.focus();
  fetch('/api/folders', { cache:'no-store' }).then(r => r.json()).then(r => {
    if (!newMode || !$('nf-cwd')) return;
    cwd.replaceChildren(); const last = localStorage.getItem('cc.newcwd');
    // Dossier déclaré (newSession.folders de config.json) sans session récente : ni date ni compte, juste « déclaré ».
    for (const d of r.folders || []) {
      const info = d.count ? T('   —   il y a ' + ago(Date.now() - d.last), '   —   ' + ago(Date.now() - d.last) + ' ago') + ' · ' + d.count + ' session' + (d.count > 1 ? 's' : '') : '   —   ' + T('déclaré', 'declared');
      // Dossier non approuvé dans Claude Code (untrusted) : le serveur refuse d'y lancer sans branche neuve.
      const warn = d.untrusted ? '   ·   ⚠ ' + T('non approuvé dans Claude Code', 'not trusted in Claude Code') : '';
      const o = el('option', null, (d.declared ? '★ ' : '') + (short(d.path) || d.path) + info + warn); o.value = d.path;
      if (d.untrusted) o.dataset.untrusted = '1';
      o.title = d.path + (d.declared ? T('\nDéclaré dans config.json (newSession.folders)', '\nDeclared in config.json (newSession.folders)') : '') + (d.untrusted ? '\n' + untrustedHint() : ''); cwd.append(o);
    }
    cwd.onchange = () => trustHint();
    if (!cwd.options.length) { cwd.append(el('option', null, T('aucun dossier récent trouvé', 'no recent folder found'))); return; }
    const from = draft && draft.cwd ? draft.cwd : fork && fork.cwd ? fork.cwd : '';
    const want = from ? from.replace(/\\+$/, '').toLowerCase() : null, same = want && [...cwd.options].find(o => o.value.toLowerCase() === want);
    if (same) cwd.value = same.value;
    else if (draft && draft.cwd) say(T('le dossier du brouillon n’est plus proposé (' + (short(draft.cwd) || draft.cwd) + ') : choisis-en un autre', 'the draft’s folder is no longer offered (' + (short(draft.cwd) || draft.cwd) + '): choose another one'));
    else if (last && [...cwd.options].some(o => o.value === last)) cwd.value = last;
    cwd.disabled = false; trustHint();
  }).catch(() => { cwd.replaceChildren(el('option', null, T('liste des dossiers indisponible', 'folder list unavailable'))); });
}
// Approbation des dossiers par Claude Code (/api/folders → untrusted ; serveur : trust.ts). Une session lancée dans un
// dossier non approuvé attendrait, sans rien montrer ici, la question « Do you trust the files in this folder? ». Sans
// branche, le serveur refuse ; avec une branche neuve, le worktree créé n'est jamais approuvé d'avance : on prévient
// que l'onglet posera la question.
function untrustedHint() { return T('⚠ Dossier non approuvé dans Claude Code : une session lancée ici resterait bloquée sur la question d’approbation, sans rien afficher sur cette page. Lance une fois « claude » dans ce dossier et accepte, ou choisis un dossier approuvé.', '⚠ Folder not trusted in Claude Code: a session started here would wait on the trust question, showing nothing on this page. Run “claude” once in this folder and accept, or choose a trusted folder.'); }
function trustHint() {
  const h = $('nf-trust'), cwd = $('nf-cwd'), br = $('nf-branch'); if (!h || !cwd) return;
  const o = cwd.selectedOptions && cwd.selectedOptions[0];
  const text = br && br.value.trim()
    ? T('⚠ Branche neuve : Claude Code demandera d’approuver le worktree créé — réponds dans l’onglet, sinon la session reste bloquée sans apparaître ici.', '⚠ New branch: Claude Code will ask to trust the new worktree — answer in the tab, or the session stays stuck without showing up here.')
    : o && o.dataset.untrusted ? untrustedHint() : '';
  h.hidden = !text; h.textContent = text;
}
async function launchNew() {
  const cwd = $('nf-cwd'), pr = $('nf-prompt'), mo = $('nf-model'), br = $('nf-branch');
  if (!cwd || cwd.disabled || launching) return;
  if (attBusy('new')) return say(T('pièce jointe en cours d’envoi — un instant', 'attachment still uploading — one moment'));
  // Premier message : passé par fichier au lancement (pas tapé) — les retours à la ligne y sont gardés, pièces en fin.
  const refs = withAttachments('new', ''), prompt = [pr.value.trim(), refs].filter(Boolean).join('\n\n');
  if (!addNewTag()) return;          // un tag tapé mais pas encore validé part avec la session — ou bloque s'il est invalide
  launching = true; $('nf-go').disabled = true; say(T('lancement d’une nouvelle session…', 'starting a new session…'));
  try {
    const r = await (await fetch('/api/new', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ cwd: cwd.value, prompt, model: mo.value.trim(), branch: br.value.trim(), forkFrom: newFork ? newFork.sessionId : '', tags: newTags, draftId: newPrefill && newPrefill.draft ? newPrefill.draft.id : '' }) })).json();
    if (r.error) say(T('non lancée : ', 'not launched: ') + r.error);
    else { clearAttachments('new'); localStorage.setItem('cc.newcwd', cwd.value); localStorage.setItem('cc.newmodel', mo.value.trim()); if (newPrefill && newPrefill.draft) tick(); const wt = !!br.value.trim(); launching = false; closeNew();
      // La page va à la nouvelle session : sélectionnée tout de suite, gardée (pas « disparue ») le temps qu'elle apparaisse.
      if (r.sessionId) { relaunching = { key: r.sessionId, until: Date.now() + (wt ? 180000 : 90000) }; select(r.sessionId); }
      say(wt ? T('onglet ouvert : création du worktree puis lancement — la page l’affiche dès qu’elle apparaît', 'tab opened: creating the worktree then launching — the page shows it as soon as it appears') : T('nouvel onglet ouvert — la page affiche la session dès qu’elle apparaît', 'new tab opened — the page shows the session as soon as it appears')); return; }
  } catch { say(T('échec de la demande', 'request failed')); }
  launching = false; if ($('nf-go')) $('nf-go').disabled = false;
}

// Largeur de la colonne « Derniers prompts » : glisser la poignée entre l'écran et la colonne, double-clic pour la
// largeur par défaut ; retenue d'une visite à l'autre (cc.promptw).
function promptResizer(split) {
  const w = +localStorage.getItem('cc.promptw'); if (w) split.style.setProperty('--promptw', w + 'px');
  const rz = el('div', 'vrz'); rz.title = T('Glisser pour élargir ou réduire les derniers prompts — double-clic : largeur par défaut', 'Drag to widen or narrow the recent prompts — double-click: default width');
  const clamp = x => Math.round(Math.max(220, Math.min(x, split.getBoundingClientRect().width - 320)));
  rz.onpointerdown = e => {
    e.preventDefault(); rz.setPointerCapture(e.pointerId); rz.classList.add('drag'); document.body.style.userSelect = 'none';
    const move = ev => split.style.setProperty('--promptw', clamp(split.getBoundingClientRect().right - ev.clientX) + 'px');
    const up = () => {
      rz.classList.remove('drag'); document.body.style.userSelect = ''; rz.removeEventListener('pointermove', move); rz.removeEventListener('pointerup', up);
      const v = parseInt(split.style.getPropertyValue('--promptw')); if (v) localStorage.setItem('cc.promptw', String(v));
    };
    rz.addEventListener('pointermove', move); rz.addEventListener('pointerup', up);
  };
  rz.ondblclick = () => { split.style.removeProperty('--promptw'); localStorage.removeItem('cc.promptw'); };
  return rz;
}

// Un run (hd:, run:) ou une passe (pass:) vient d'une lecture à part : tant qu'elle n'a pas eu lieu, la clé n'est pas « disparue ».
const sourcePending = key => (/^(hd|run):/.test(key) && !runsRead && !launcherOff()) || (/^pass:/.test(key) && !autoData && !automationsOff());
function renderDetail(force) {
  spinPhase();
  keepDraft();   // avant tout re-rendu : la zone de réponse peut être recréée (ou quittée)
  syncRoute();
  $('newbtn').classList.toggle('on', newMode); $('bcbtn').classList.toggle('on', bcMode); $('boardbtn').classList.toggle('on', boardMode);
  $('launchbtn').classList.toggle('on', launchMode); $('chatsbtn').classList.toggle('on', chatsMode);
  document.body.classList.toggle('finding', findMode);
  const mt = launchMode ? T('Lanceur', 'Launcher') : chatsMode ? T('Conversations Teams', 'Teams conversations') : boardMode ? T('Tableau par projet', 'Board by project') : newMode ? T('Nouvelle session', 'New session') : bcMode ? T('Message à plusieurs sessions', 'Message to several sessions') : findMode ? T('Recherche dans les conversations', 'Search in conversations') : null;
  if (mt) setMobileTitle(mt); else { const cur = selected && byKey(selected); cur ? setMobileTitle(label(cur), cur.look || cur.state) : setMobileTitle(T('Vue d’ensemble', 'Overview')); }
  if (launchMode) { if (detailKey !== '__launch__' || force) renderLauncher(); return; }   // rafraîchie par son propre minuteur (10 s)
  if (chatsMode) { if (detailKey !== '__chats__' || force) renderChats(); return; }   // rafraîchie par son minuteur (30 s) et à chaque nouvelle liste
  if (boardMode) { renderBoard(force); return; }
  if (newMode) { if (detailKey !== '__new__' || force) renderNew(); return; }
  if (bcMode) { if (detailKey !== '__bc__' || force) renderBc(); return; }
  if (findMode) { if (detailKey !== '__find__' || force) renderFind(); return; }
  const main = $('main'); const it = selected && byKey(selected);
  if (!it) {
    if (selected && data && closedData.days && !awaitingRelaunch(selected) && !sourcePending(selected)) { selected = null; sessionStorage.removeItem('cc.sel'); navReplace = true; syncRoute(); }   // session disparue : adresse corrigée, sans entrée
    if (detailKey !== '' || force) { detailKey = ''; main.replaceChildren(el('div', null), el('div', null)); main.firstChild.id = 'head'; main.lastChild.id = 'body'; }
    renderOverview(); return;
  }
  if (it.kind === 'run') return renderRunDetail(pickRun(it), force);
  if (it.kind === 'pass') return renderPassDetail(it, force);
  if (detailKey !== it.key || force) {
    detailKey = it.key; main.replaceChildren();
    // Bandeau collant (nom de la session + état « au travail ») : enfant direct de main, qui défile — dans #head,
    // il ne collerait que tant que l'en-tête est à l'écran.
    const stick = el('div'); stick.id = 'dstick';
    const head = el('div'); head.id = 'head'; const acts = el('div'); acts.id = 'dacts'; const body = el('div'); body.id = 'body'; main.append(stick, head, acts, body);
    // Ouverte depuis la recherche dans les conversations : on garde sous les yeux les passages trouvés.
    const fh = findRes && findQ && $('q').value.trim() === findQ && findRes.hits.find(h => h.sessionId === it.sessionId);
    if (fh) {
      body.append(el('h2', null, T('Passages trouvés — « ' + findQ + ' » · ' + fh.count + ' message' + (fh.count > 1 ? 's' : ''), 'Matches — "' + findQ + '" · ' + fh.count + ' message' + (fh.count > 1 ? 's' : ''))));
      const box = el('div', 'fhit ' + it.state); for (const s of fh.snippets) box.append(snipEl(s, findQ)); body.append(box);
    }
    const term = isLive(it) && !it.headless;              // automate (claude -p) : pas de terminal
    if (term) { const dg = el('div'); dg.id = 'dialog'; body.append(dg); }
    if (term) {
      body.append(el('h2', null, T('Répondre', 'Reply')));
      const sg = el('div', 'suggest'); sg.id = 'suggest'; sg.hidden = true; body.append(sg);
      const box = el('div', 'sendbox'); const inp = promptArea('sendtext');
      inp.dataset.key = it.key; inp.value = draftLoad(sessionStorage, it.key); inp.addEventListener('input', keepDraft);
      const btn = el('button', 'primary', T('Envoyer', 'Send')); btn.id = 'sendbtn'; btn.onclick = () => sendReply();
      box.append(inp, btn);
      for (const q of ['go', T('oui', 'yes'), T('non', 'no'), 'continue']) { const b = el('button', 'quick', q); b.title = T('Pré-remplit la réponse (n\'envoie pas)', 'Prefills the reply (does not send)'); b.onclick = () => { inp.value = q; growArea(inp); inp.focus(); }; box.append(b); }
      // Commandes « / » : menu sous la zone, et boutons de raccourci (une commande toute faite, en un clic).
      const live = () => byKey(inp.dataset.key) || it;
      slashAttach(inp, () => ({ pid: cmdKey(live()), busy: live().status === 'busy', many: false, it: live() }));
      // Autre poste : ni changement de modèle ni pièce jointe (le fichier serait posé ici, pas là-bas).
      const sc = el('span', 'shortcuts'); box.append(sc); if (it.kind === 'open') box.append(modelPicker(live)); shortcutBar(sc, cmdKey(it), c => sendShortcut(live(), c));
      const hint = el('div', 'hint'); hint.id = 'sendhint'; if (it.kind === 'open') box.append(attachBar('reply:' + it.key)); box.append(hint); body.append(box);
      if (inp.value) growArea(inp);   // brouillon repris : la zone reprend sa hauteur
    }
    const pr = el('div', 'prompts'); pr.id = 'prompts';
    if (it.headless && it.reply) { body.append(el('h2', null, T('Dernier message', 'Last message')), mdBody('reply', it.reply)); }
    if (term) {
      const split = el('div', 'split'), ct = el('div', 'cterm'), cp = el('div', 'cprompts');
      const pre = el('pre', null, '…'); pre.id = 'screen';
      // Deux vues du même panneau : l'écran (ce que le terminal affiche encore) ou la conversation complète (transcript).
      const vh = el('h2', 'viewtabs');
      for (const [v, t, h] of [['screen', T('Écran du terminal', 'Terminal screen'), T('En direct, lecture seule : seulement ce que le terminal affiche encore', 'Live, read-only: only what the terminal still shows')], ['conv', T('Conversation complète', 'Full conversation'), T('Tout l’historique de la session, relu dans son transcript — défile jusqu’au premier message  ( h )', 'The whole session history, read from its transcript — scrolls back to the first message  ( h )')]]) {
        const b = el('button', 'vtab', t); b.dataset.view = v; b.title = h; b.onclick = () => setConvView(v); vh.append(b);
      }
      ct.append(vh, pre, convPane()); cp.append(el('h2', null, T('Derniers prompts', 'Recent prompts')), pr);
      split.append(ct, promptResizer(split), cp); body.append(split);
    } else body.append(el('h2', null, T('Derniers prompts', 'Recent prompts')), pr);
    if (!term) body.append(el('h2', null, T('Conversation complète', 'Full conversation')), convPane());
    applyConvView(it);
  }
  const stick = $('dstick'); stick.replaceChildren(); stick.className = it.state + ($('main').scrollTop > 0 ? ' stuck' : '');
  const head = $('head'); head.replaceChildren(); head.className = it.state;
  { const dt = el('div', 'dtitle', label(it)), d = driftTag(it); dt.title = label(it); if (d) dt.append(d); stick.append(dt); }
  const sline = el('div', 'sline'); stick.append(sline);
  const chip = el('span', 'chip'); chip.append(el('span', 'dot'));
  if (it.state === 'busy') chip.append(spinLabel(it)); else chip.append(T(LABEL[it.state] + ' · depuis ' + ago(data.now - it.since), LABEL[it.state] + ' · for ' + ago(data.now - it.since)) + (it.waitingFor ? ' · ' + it.waitingFor : ''));
  if (it.status === 'shell' && it.state !== 'shell') { const t = el('span', 'tag cl', T('commande en arrière-plan', 'background command')); t.title = T('Tour terminé ; une commande lancée en arrière-plan tourne encore dans cette session', 'Turn finished; a command started in the background is still running in this session'); chip.append(t); }
  if (it.kind === 'open' && schedOf(it).length) { const t = el('span', 'tag sched', '⏰ ' + schedOf(it).map(j => j.at ? new Date(j.at).toLocaleTimeString(LOCALE, { hour:'2-digit', minute:'2-digit' }) : '?').join(', ')); t.title = schedList(it); chip.append(t); }
  if (it.stale) { const t = el('span', 'tag cl', T('statut corrigé d\'après l\'écran', 'status corrected from the screen')); t.title = T('Claude Code la déclare encore « au travail », mais ' + (it.stale === 'hook' ? 'elle a signalé la fin de son tour (hook Stop)' : 'son écran montre un tour terminé'), 'Claude Code still reports it as "working", but ' + (it.stale === 'hook' ? 'it signalled the end of its turn (Stop hook)' : 'its screen shows a finished turn')); chip.append(t); }
  sline.append(chip);
  if (it.model) sline.append(modelBadge(it.model, false, T('Modèle du dernier message de la session (suit un /model en cours de route)', 'Model of the last message of the session (follows a /model on the way)')));
  if (it.tokens) { const tk = el('span', 'tok', T('  ·  contexte : ', '  ·  context: ') + it.tokens.toLocaleString(LOCALE) + ' tokens'); tk.title = T('Taille du dernier appel au modèle : entrée + cache lu + cache écrit', 'Size of the last model call: input + cache read + cache written'); sline.append(tk); }
  const meta = el('div', 'meta', [it.machine ? '🖧 ' + it.machine : null, it.name, short(it.cwd), it.pid ? 'pid ' + it.pid : null, it.sessionId, it.version ? 'v' + it.version : null, it.startedAt ? T('lancée il y a ' + ago(data.now - it.startedAt), 'started ' + ago(data.now - it.startedAt) + ' ago') : null].filter(Boolean).join(' · '));
  const a = prLink(it); if (a) { meta.append(' · ', a); prTags(it).forEach(t => meta.append(t)); }
  head.append(meta);
  const dtags = tagChips(it, 'dtags'); if (dtags) head.append(dtags);
  const dsch = it.kind === 'open' ? schedOf(it) : [];
  if (dsch.length) {
    const box = el('div', 'twaits sched');
    for (const j of dsch) {
      const l = el('div', 'tw sched', schedLine(j, data.now) + (j.durable ? T(' · enregistrée sur disque', ' · saved on disk') : ''));
      if (j.prompt) { l.append(el('span', 'tx', ' — « ' + (j.prompt.length > 220 ? j.prompt.slice(0, 220) + '…' : j.prompt) + ' »')); l.title = j.prompt; }
      box.append(l);
    }
    if (schedFragile(it).length) box.append(el('div', 'tx warn', '⚠ ' + SCHED_WARN));
    head.append(box);
  }
  const dinb = teamsInboundOf(it);
  if (dinb) {
    const box = el('div', 'twaits');
    const l = el('div', 'tw inb', T('📥 Demande Teams de ', '📥 Teams request from ') + (dinb.chatLabel || dinb.from)); l.append(el('span', 'tx', T(' — session ouverte automatiquement ; rien n’est envoyé sans ton accord.', ' — session opened automatically; nothing is sent without your approval.')));
    if (it.kind === 'open' && it.status === 'idle') {
      const bs = el('span', 'twb'); const x = el('button', null, inboundIsArmed(it) ? T('Confirmer l’envoi à ' + (dinb.chatLabel || dinb.from), 'Confirm sending to ' + (dinb.chatLabel || dinb.from)) : T('Envoyer la réponse proposée', 'Send the proposed reply'));
      x.title = T('Demande à la session de poster sa réponse proposée dans le chat Teams (deux clics). Pour la corriger d’abord, réponds à la session.', 'Asks the session to post its proposed reply in the Teams chat (two clicks). To correct it first, reply to the session.');
      x.onclick = () => teamsInboundSend(it, dinb); bs.append(x); l.append(bs);
    }
    box.append(l); head.append(box);
  }
  const dtws = teamsWaitsOf(it);
  if (dtws.length) {
    const box = el('div', 'twaits');
    for (const w of dtws) {
      const l = el('div', 'tw' + (w.status === 'replied' ? ' rep' : w.alertedAt ? ' alert' : ''), teamsWaitLine(w, data.now, data.teams.reminders)); l.append(el('span', 'tx', T(' — « ' + w.excerpt + ' »', ' — "' + w.excerpt + '"')));
      const bs = el('span', 'twb');
      const b = (txt, action, tip) => { const x = el('button', null, txt); x.title = tip; x.onclick = () => teamsWaitAction(it, w, action); bs.append(x); };
      if (w.status === 'open') {
        b(T('Relancer maintenant', 'Remind now'), 'remind', T('La session écrit tout de suite une relance courte dans le chat (envoi autonome), même hors calendrier', 'The session writes a short reminder in the chat right away (sent on its own), even outside the schedule'));
        b(T('Repousser', 'Snooze'), 'snooze', T('Pas de relance avant le prochain jour ouvré à 10 h', 'No reminder before the next working day at 10 am'));
      }
      b(T('Ne plus attendre', 'Stop waiting'), 'dismiss', T('Ferme l’attente : plus de relance, et une réponse éventuelle ne sera pas transmise', 'Closes the wait: no more reminders, and any reply will not be passed on'));
      l.append(bs); box.append(l);
    }
    if (!data.teams.enabled) box.append(el('div', 'tx', T('Surveillance éteinte : aucune réponse ne sera lue tant que « node teams-watcher.ts login » n’a pas été fait.', 'Watching is off: no reply will be read until "node teams-watcher.ts login" has been run.')));
    else if (!data.teams.reminders) box.append(el('div', 'tx', T('Relances automatiques éteintes (modules.teams de config.json) : seul « Relancer maintenant » écrit au collègue.', 'Automatic reminders are off (modules.teams in config.json): only "Remind now" writes to your colleague.')));
    head.append(box);
  }
  const dvals = validationsOf(it);
  if (dvals && dvals.items.length) {
    const box = el('div', 'twaits vals');
    box.append(el('div', 'vh', T('Validations métier — ' + (validationBadge(dvals) || 'aucune en cours') + ' · une validation n’est pas un go', 'Business validations — ' + (validationBadge(dvals) || 'none pending') + ' · a validation is not a go')));
    for (const i of dvals.items) {
      const l = el('div', 'tw val' + (i.withdrawn ? ' wd' : i.decision === 'refuse' || i.state === 'non-qualifiee' ? ' ref' : i.state === 'tranchee' ? '' : ' pre'), validationLine(i, data.now));
      l.append(el('div', 'tx', i.question));
      if (i.reserve) l.append(el('div', 'tx', T('Réserve : ', 'Reservation: ') + i.reserve));
      if (i.quote) l.append(el('div', 'tx q', T('« ' + i.quote + ' »', '"' + i.quote + '"')));
      box.append(l);
    }
    head.append(box);
  }
  if (it.kind === 'open') head.append(gitBlock(it));
  if (it.headless) {
    head.append(el('div', 'banner', T('Automate sans terminal : ce claude -p a été lancé par un script (' + (it.entrypoint || 'sdk') + '), par exemple le diagnostic automatique. Il n’a ni onglet, ni écran, et ne lit pas de réponse : il se pilote depuis son lanceur. On voit ici son avancement (derniers prompts, dernier message, git).', 'Automation without a terminal: this claude -p was started by a script (' + (it.entrypoint || 'sdk') + '), for example the automatic diagnosis. It has no tab, no screen, and reads no reply: it is driven from its launcher. Here you see its progress (recent prompts, last message, git).')));
    actionBar($('dacts'), it, actionsFor(it, actionCtx(it)));
    return renderPromptsOnly(it);
  }
  actionBar($('dacts'), it, actionsFor({ ...it, resumeCmd: resumeCmd(it) }, actionCtx(it)));
  if (it.kind === 'peer') {
    const b = el('div', 'banner', T('Session du poste « ' + it.machine + ' » : d’ici tu la lis et tu lui réponds. Afficher son onglet, la fermer, la relancer ou joindre un fichier se fait sur ', 'Session on machine "' + it.machine + '": from here you read it and reply to it. Showing its tab, closing it, restarting it or attaching a file is done on '));
    const u = peerPage(data.server && data.server.relay && data.server.relay.url, it);
    if (u) { const a = el('a', null, T('la page de ce poste', 'that machine’s page')); a.href = u; a.target = '_blank'; a.rel = 'noopener'; b.append(a, '.'); } else b.append(T('la page de ce poste.', 'that machine’s page.'));
    head.append(b);
  }
  if (it.kind === 'closed') head.append(el('div', 'banner', T('Session fermée : son terminal n’existe plus. Tu peux la rouvrir dans un nouvel onglet (la conversation reprend où elle s’était arrêtée)' + (it.hidden ? ', ou la ré-afficher dans la liste — elle est masquée.' : ', ou la masquer si tu n’en as plus besoin.'), 'Closed session: its terminal no longer exists. You can reopen it in a new tab (the conversation picks up where it left off)' + (it.hidden ? ', or show it in the list again — it is hidden.' : ', or hide it if you no longer need it.'))));
  const inp = $('sendtext');
  if (inp) {
    // Au travail : l'invite de Claude Code reste vide et active — le message y est tapé et Claude Code le met EN FILE,
    // comme s'il avait été tapé dans le terminal pendant le tour.
    const queue = it.status === 'busy', can = it.status === 'idle' || it.status === 'shell' || queue;
    inp.disabled = $('sendbtn').disabled = !can || sending;
    $('sendbtn').textContent = queue ? T('Mettre en file', 'Queue') : T('Envoyer', 'Send');
    inp.placeholder = queue ? T('La session travaille : ton message sera mis en file  ( r )  — Entrée pour l’ajouter · Maj+Entrée : à la ligne', 'The session is working: your message will be queued  ( r )  — Enter to add it · Shift+Enter: new line')
      : can ? (suggestKey === it.key && suggestion ? T('Tab : reprendre la proposition ci-dessus · ', 'Tab: take the suggestion above · ') : '') + T('Répondre à cette session…  ( r )  — Entrée pour envoyer · Maj+Entrée : à la ligne', 'Reply to this session…  ( r )  — Enter to send · Shift+Enter: new line')
      : T('Réponse impossible : la session ' + (it.status === 'waiting' ? 'attend la réponse à un dialogue — réponds-y dans le panneau au-dessus (dialogue ou menu) ou dans son onglet' : 'n’a pas d’invite libre'), 'Cannot reply: the session ' + (it.status === 'waiting' ? 'is waiting for the answer to a dialog — answer it in the panel above (dialog or menu) or in its tab' : 'has no free prompt'));
    $('sendhint').textContent = queue ? T('Tapé dans l’invite de la session pendant qu’elle travaille : Claude Code le met en file et le prend dès qu’il peut (comme dans le terminal). Seulement si son invite est vide — les retours à la ligne y deviennent des espaces.', 'Typed into the session prompt while it works: Claude Code queues it and takes it as soon as it can (as in the terminal). Only if its prompt is empty — line breaks become spaces.')
      : can ? T('Tapé dans le terminal de la session, seulement si son invite est vide — les retours à la ligne y deviennent des espaces.', 'Typed into the session terminal, only if its prompt is empty — line breaks become spaces.') : '';
  }
  renderPromptsOnly(it);
}
function renderPromptsOnly(it) {
  const pr = $('prompts'); if (!pr) return; const sig = JSON.stringify([it.prompts || [], it.queued || []]);
  if (pr.dataset.sig !== sig) {
    pr.dataset.sig = sig; pr.replaceChildren();
    const ps = (it.prompts || []).slice().reverse();
    // Messages en file (tapés pendant qu'elle travaille) : pas encore dans l'historique, Claude Code les prendra au tour suivant.
    for (const q of (it.queued || []).slice().reverse()) {
      const d = el('div', 'prompt queued'), w = el('div', 'when'); w.append(el('span', 'tag', T('en file', 'queued')), ' ' + (q.at ? new Date(q.at).toLocaleString(LOCALE) : ''));
      d.title = T('Mis en file pendant que la session travaille : Claude Code le prendra dès qu’il peut', 'Queued while the session works: Claude Code will take it as soon as it can'); d.append(w, el('div', null, q.text)); pr.append(d);
    }
    if (!ps.length && !(it.queued || []).length) pr.append(el('div', 'empty', it.headless ? T('Un automate reçoit ses consignes par son lanceur : rien dans l’historique des prompts.', 'An automation gets its instructions from its launcher: nothing in the prompt history.') : T('Aucun prompt récent dans l\'historique.', 'No recent prompt in the history.')));
    for (const p of ps) { const d = el('div', 'prompt'); d.append(el('div', 'when', new Date(p.at).toLocaleString(LOCALE)), el('div', null, p.text)); pr.append(d); }
  }
}

function renderOverview() {
  const head = $('head'), body = $('body'); const items = allItems().filter(it => !it.hidden);
  head.className = ''; head.replaceChildren(el('div', 'dtitle', T('Vue d\'ensemble', 'Overview')), langSwitch());
  const tiles = el('div', 'tiles');
  for (const st of ['waiting', 'ask', 'done', 'busy', 'shell', 'idle', 'auto', 'closed']) {
    const n = items.filter(it => it.state === st).length, on = activeState() === st;
    const t = el('button', 'tile ' + st + (on ? ' on' : '') + (n ? '' : ' zero')); t.type = 'button';
    t.append(el('b', null, n), el('span', null, LABEL[st]));
    t.title = on ? T('Filtre actif — clic : afficher toutes les sessions', 'Filter on — click: show all sessions') : T('Clic : ne montrer que ces sessions dans la liste', 'Click: show only these sessions in the list');
    t.onclick = () => filterState(st); tiles.append(t);
  }
  head.append(tiles);
  const cl = allItems().filter(closable);
  const nsig = idleSig() + '/' + restartSig() + '/' + data.restarts.length + ':' + (data.restarts.length ? data.restarts[data.restarts.length - 1].at : 0) + '/' + data.notifs.length + '/' + (data.notifs.length ? data.notifs[data.notifs.length - 1].at : 0) + '/' + (data.reboot ? data.reboot.sessions.map(s => s.sessionId).join(',') : '') + '/' + cl.map(it => it.key).join(',')
    + '/' + (data.quota || []).map(q => q.alias + ':' + q.weeklyPct + ':' + q.measuredAt + ':' + q.status).join(',') + '/' + Math.floor(Date.now() / 60000) + '/' + (autoData ? autoData.now : '');
  if (body.dataset.sig === 'overview' && body.dataset.n === nsig) return;
  body.dataset.sig = 'overview'; body.dataset.n = nsig; body.replaceChildren();
  const rp = rebootPanel(); if (rp) body.append(rp);
  const qs = quotaSection(); if (qs) body.append(el('h2', null, T('Quota Claude de la semaine', 'Claude quota this week')), qs);
  const sp = restartPanel(); if (sp) body.append(sp);
  const as = automationSection(); if (as) body.append(el('h2', null, T('Automates du poste', 'Automations on this machine')), as);
  if (cl.length) {
    body.append(el('h2', null, T('Peuvent se fermer — ', 'Can be closed — ') + cl.length));
    const act = el('div', 'actions');
    const bc = el('button', 'primary', T('Fermer la sélection…', 'Close the selection…')); bc.title = T('Ferme les sessions cochées (/exit) ; elles restent reprenables depuis « Fermées »', 'Closes the checked sessions (/exit); they can still be reopened from "Closed"'); bc.onclick = () => closeMany(cl.filter(it => closePick.get(it.key) !== false));
    const bt = el('button', null, T('Tout cocher / décocher', 'Check / uncheck all')); bt.onclick = () => { const all = cl.every(it => closePick.get(it.key) !== false); cl.forEach(it => closePick.set(it.key, !all)); renderDetail(true); };
    act.append(bc, bt); body.append(act);
    const box = el('div', 'notifs');
    for (const it of cl) { const d = el('div', 'notif done pick');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = closePick.get(it.key) !== false; cb.onclick = e => e.stopPropagation(); cb.onchange = () => closePick.set(it.key, cb.checked);
      d.append(cb, el('span', 'when', it.git.worktree ? it.git.top.split('\\').pop() : T('sans worktree', 'no worktree')), el('span', 'nt', label(it)), el('span', 'nx', T((prMerged(it) ? 'PR #' + it.pr + ' mergée' : 'branche intégrée à master') + (it.git.worktree ? ', rien à commiter ni à pousser' : ''), (prMerged(it) ? 'PR #' + it.pr + ' merged' : 'branch merged into master') + (it.git.worktree ? ', nothing to commit or push' : '')))); d.title = T('Sélectionner la session', 'Select the session'); d.onclick = () => select(it.key, true); box.append(d); }
    body.append(box);
  }
  const ip = idlePanel(); if (ip) body.append(ip);
  body.append(el('h2', null, T('Notifications récentes', 'Recent notifications')));
  if (!data.notifs.length) body.append(el('div', 'empty', T('Aucune notification envoyée pour l\'instant.', 'No notification sent yet.')));
  else {
    const box = el('div', 'notifs');
    for (const nf of data.notifs.slice().reverse().slice(0, 30)) {
      const d = el('div', 'notif ' + (nf.kind === 'waiting' || nf.kind === 'automation' ? 'waiting' : nf.kind === 'launcher' ? 'ask' : 'done'));
      d.append(el('span', 'dot'), el('span', 'when', new Date(nf.at).toLocaleString(LOCALE)), el('span', 'nt', (nf.kind === 'launcher' ? '🤖 ' : '') + nf.title), el('span', 'nx', nf.text));
      d.title = nf.pass ? T('Ouvrir cette passe', 'Open this pass') : nf.hd ? T('Ouvrir le dernier run de HD-', 'Open the last run of HD-') + nf.hd : nf.kind === 'launcher' ? T('Ouvrir la vue Lanceur', 'Open the Launcher view') : T('Sélectionner la session', 'Select the session');
      d.onclick = () => { if (nf.pass) openPass(nf.pass); else if (nf.hd) openRun(nf.hd); else if (nf.kind === 'launcher') openLauncher(); else if (byKey(nf.sessionId)) select(nf.sessionId, true); else say(T('cette session n\'est plus listée', 'this session is no longer listed')); };
      box.append(d);
    }
    body.append(box);
  }
  body.append(el('h2', null, T('Raccourcis clavier', 'Keyboard shortcuts')));
  const keys = el('div', 'keys');
  for (const [k, d] of [['/', T('rechercher (titre, prompt, numéro de PR, dossier, identifiant)', 'search (title, prompt, PR number, folder, id)')], ['↑ ↓', T('parcourir les sessions', 'move through the sessions')], [T('Entrée', 'Enter'), T('afficher l\'onglet de la session (ou rouvrir une session fermée)', 'show the session tab (or reopen a closed session)')],
                        ['n', T('aller à la prochaine session à traiter et afficher son onglet', 'go to the next session to handle and show its tab')], ['r', T('répondre à la session sélectionnée (Entrée envoie)', 'reply to the selected session (Enter sends)')], ['/', T('zone de réponse : menu des commandes de la session — ↑ ↓ choisir, Tab ou Entrée compléter, Échap fermer', 'reply box: the session’s command menu — ↑ ↓ choose, Tab or Enter complete, Esc close')], ['p', T('reprendre la proposition de prompt de Claude Code dans la zone de réponse (Entrée l’envoie) — aussi Tab dans la zone vide', 'take the Claude Code prompt suggestion into the reply box (Enter sends it) — also Tab in the empty box')],['f', T('mettre la session en favori, ou la retirer (★ à côté de la recherche : favoris seulement)', 'add the session to favourites, or remove it (★ next to the search: favourites only)')], ['c', T('copier la commande de reprise', 'copy the resume command')], ['1 – 9', T('session bloquée sur un dialogue : choisir l’option correspondante (tapée dans son terminal)', 'session waiting on a dialog: pick the matching option (typed into its terminal)')], ['+', T('lancer une nouvelle session (dossier, premier message, modèle)', 'start a new session (folder, first message, model)')], ['d', T('nouvelle session à partir de la session sélectionnée : elle reprend toute sa conversation (fork), l’originale n’est pas touchée', 'new session from the selected session: it carries over its whole conversation (fork), the original is not touched')],['h', T('basculer entre l’écran du terminal et la conversation complète (tout l’historique, relu dans le transcript)', 'switch between the terminal screen and the full conversation (the whole history, read from the transcript)')], ['b', T('revenir à la session consultée juste avant (liste « Consultées récemment » en tête)', 'go back to the session viewed just before ("Recently viewed" list at the top)')], ['x', T('fermer la session sélectionnée (avec confirmation ; elle reste reprenable) — sur une session déjà fermée : la masquer / ré-afficher', 'close the selected session (with confirmation; it can still be reopened) — on a session already closed: hide / show it again')], [T('Échap', 'Esc'), T('vider la recherche, puis revenir à cette vue', 'clear the search, then come back to this view')],
                        [T('sélection', 'selection'), T('tout texte sélectionné à la souris est copié dans le presse-papier au relâchement', 'any text selected with the mouse is copied to the clipboard on release')], ['Ctrl+K Ctrl+U', T('zone de saisie : couper jusqu’à la fin / au début de la ligne', 'text box: cut to the end / start of the line')], ['Ctrl+Y', T('zone de saisie : recoller le dernier texte coupé', 'text box: paste back the last cut text')], ['Ctrl+E', T('zone de saisie : aller en fin de ligne', 'text box: go to the end of the line')], ['Alt+B Alt+F', T('zone de saisie : reculer / avancer d’un mot', 'text box: move back / forward one word')], ['Ctrl+_', T('zone de saisie : annuler (comme Ctrl+Z)', 'text box: undo (like Ctrl+Z)')]]) {
    const kk = el('span'); k.split(' ').forEach((x, i) => { if (i) kk.append(' '); kk.append(el('kbd', null, x)); }); keys.append(kk, el('span', null, d));
  }
  body.append(keys);
  body.append(el('h2', null, T('Dernières relances', 'Recent restarts')));
  if (!data.restarts.length) body.append(el('div', 'empty', T('Aucune relance enregistrée.', 'No restart recorded.')));
  else {
    const w = el('div', 'tablewrap'), t = el('table'), hr = el('tr'); [T('Quand', 'When'), 'Session', T('Résultat', 'Result')].forEach(h => hr.append(el('th', null, h))); t.append(hr);
    for (const r of data.restarts.slice().reverse()) { const tr = el('tr');
      tr.append(el('td', null, new Date(r.at).toLocaleString(LOCALE)), el('td', null, r.name + ' (' + r.sessionId.slice(0, 8) + ')'), el('td', r.code === 0 ? 'ok' : 'ko', r.result)); t.append(tr); }
    w.append(t); body.append(w);
  }
}

// ── Dialogues ──
// Une session qui ATTEND affiche un dialogue dans son terminal : question à choix (AskUserQuestion), demande de
// permission, menu. On le lit sur l'écran (options « N. libellé » au-dessus du pied « Enter to select · Esc to
// cancel ») et on propose de cliquer l'option : la page tape son chiffre dans la console. Le clavier ci-dessous
// couvre le reste (cases à cocher, onglets de questions, « Submit »), l'écran du terminal montre le résultat.
// QUESTION AVEC APERÇU : chaque option porte une maquette, dessinée dans un cadre À DROITE de la liste. Deux effets.
// Le cadre partage les lignes des options (« 1. libellé     ┌────┐ ») : on coupe la ligne au cadre, sinon il finit
// dans le libellé. Et ce dialogue-là N'ÉCOUTE PAS LES CHIFFRES (son pied : « Enter to select · ↑/↓ to navigate · n to
// add notes ») : `preview` le signale, l'option se choisit alors aux flèches depuis le curseur, puis Entrée.
const SEP = /^[─━═-]{8,}$/, BOX = /\s+[┌╭│└╰├].*$/;
function parseDialog(text) {
  const R = text.split('\n'), L = R.map(s => s.replace(/^\s*│ ?/, '').replace(/\s*│\s*$/, ''));
  let end = L.length;
  for (let i = L.length - 1; i >= Math.max(0, L.length - 14); i--) if (/enter to (select|confirm|submit|view)|esc to (cancel|exit|go back|close)|to navigate/i.test(L[i])) { end = i; break; }
  const opts = []; let first = -1, submit = false, preview = false;
  for (let i = Math.max(0, end - 45); i < end; i++) {
    if (opts.length && (/^\s{4,}[┌╭│└╰├]/.test(R[i]) || /^\s*Notes: press n\b/.test(R[i]))) { preview = true; continue; }   // cadre seul, pied de l'aperçu
    if (/\S\s+[┌╭│└╰├]/.test(R[i]) && !/^\s*│/.test(R[i])) { L[i] = R[i].replace(BOX, ''); preview = true; }
    const m = L[i].match(/^\s*(❯\s*)?(\d{1,2})\.\s+(.*\S)\s*$/);
    if (m) {
      const num = +m[2];
      if (num === 1) { opts.length = 0; first = i; }
      if (num === opts.length + 1) { opts.push({ num, label: m[3], sel: !!m[1], expect: m[2] + '. ' + m[3], desc: [] }); continue; }
    }
    const t = L[i].trim();
    if (opts.length && t === 'Submit') { submit = true; continue; }   // ligne « Submit » d'un choix multiple
    if (opts.length && t && !SEP.test(t) && /^\s{3,}/.test(L[i])) opts[opts.length - 1].desc.push(t);
  }
  if (!opts.length) return null;
  const q = []; let tabs = null;
  for (let i = first - 1, n = 0; i >= 0 && n < 14; i--, n++) {
    const t = L[i].trim();
    if (SEP.test(t)) break;
    if (!t) continue;
    if (/[☐☒✔]/.test(t) && /submit|→|←/i.test(t)) { tabs = t; break; }
    q.unshift(t); if (q.length >= 8) break;
  }
  return { opts, q: q.join('\n'), tabs, submit, preview, multi: opts.some(o => /^\[[ ✔xX]\]/.test(o.label)), foot: end < L.length ? L[end].trim() : '' };
}
// MENU SANS OPTIONS NUMÉROTÉES (/mcp, /permissions, /config…) : rien à cliquer par son chiffre, mais le pied du dialogue
// (« ↑/↓ to navigate · Enter to view · Esc to close ») dit qu'il attend des touches. On rend ce que le terminal affiche
// depuis le trait qui ouvre le menu jusqu'au pied : le pavé de touches se lit alors sans l'écran complet (téléphone,
// vue « conversation »). Le pied sert de repère : le serveur le retrouve à l'écran avant chaque touche.
function parseKeyMenu(text) {
  const L = text.split('\n');
  let foot = -1;
  for (let i = L.length - 1; i >= Math.max(0, L.length - 14); i--) if (/enter to (select|confirm|submit|view)|esc to (cancel|exit|go back|close)|to navigate/i.test(L[i])) { foot = i; break; }
  if (foot < 0) return null;
  let start = foot;
  for (let i = foot - 1; i >= Math.max(0, foot - 60); i--) { if (/^\s*[▔─━═]{8,}\s*$/.test(L[i])) break; start = i; }
  const body = L.slice(start, foot).map(l => l.trimEnd()); while (body.length && !body[0].trim()) body.shift(); while (body.length && !body[body.length - 1].trim()) body.pop();
  return { body: body.join('\n'), foot: L[foot].trim() };
}
const MENU_KEYS = () => [['Up', '↑', T('Monter', 'Up')], ['Down', '↓', T('Descendre', 'Down')], ['Left', '←', T('Onglet ou choix précédent', 'Previous tab or choice')], ['Right', '→', T('Onglet ou choix suivant', 'Next tab or choice')],
  ['Enter', T('Entrée', 'Enter'), T('Valider la ligne', 'Confirm the line')], ['Tab', 'Tab', T('Champ suivant', 'Next field')], ['Space', T('Espace', 'Space'), T('Cocher / décocher', 'Check / uncheck')],
  ['Backspace', '⌫', T('Effacer un caractère', 'Erase one character')], ['Esc', T('Échap', 'Esc'), T('Revenir en arrière, ou fermer le menu', 'Go back, or close the menu')]];
function renderKeyMenu(it, box, m) {
  box.append(el('h2', null, T('Menu ouvert dans le terminal — pilote-le ici', 'Menu open in the terminal — drive it here')));
  const c = el('div', 'dlg');
  if (m.body) c.append(el('pre', 'menu', m.body));
  const kr = el('div', 'row keys pad');
  for (const [k, t, h] of MENU_KEYS()) { const b = el('button', k === 'Esc' ? 'esc' : null, t); b.title = h; b.onclick = () => sendKeys(it, [{ k }], m.foot, t); kr.append(b); }
  c.append(kr);
  const row = el('div', 'row'); const inp = el('input'); inp.type = 'text'; inp.maxLength = 400; inp.autocapitalize = 'off'; inp.autocomplete = 'off'; inp.spellcheck = false;
  inp.placeholder = T('Texte à taper dans le menu (recherche, règle…) — Entrée pour le taper', 'Text to type into the menu (search, rule…) — Enter to type it');
  const go = el('button', null, T('Taper', 'Type'));
  const fire = () => { const v = inp.value; if (!v.trim()) return; inp.value = ''; inp.blur(); sendKeys(it, [{ t: v }], m.foot, T('texte tapé', 'text typed')); };
  go.onclick = fire; inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); fire(); } else if (e.key === 'Escape') inp.blur(); };
  row.append(inp, go); c.append(row);
  c.append(el('div', 'hint', T('Dans le terminal : ', 'In the terminal: ') + m.foot + '. ' + T('Chaque touche est tapée dans le terminal de la session ; ce pied de menu est revérifié à l’écran juste avant. Le texte est tapé tel quel, sans Entrée. Tant que le menu est ouvert, la session ne reçoit aucun message : Échap le referme.', 'Each key is typed into the session terminal; this menu footer is checked again on the screen just before. The text is typed as is, without Enter. While the menu is open the session receives no message: Esc closes it.')));
  box.append(c);
}
function renderStuckPrompt(it, box, draft) {
  const sig = 'stuck:' + draft;
  if (sig === lastDialogSig && box.dataset.pid === String(it.pid)) return;
  lastDialogSig = sig; box.dataset.pid = it.pid; box.replaceChildren();
  const expect = draft.split('\n').map(s => s.trim()).find(Boolean) || '';
  box.append(el('h2', null, T('Invite occupée — un texte y est resté', 'Prompt busy — some text was left in it')));
  const c = el('div', 'dlg');
  c.append(el('div', 'q', draft));
  const row = el('div', 'row');
  const go = el('button', 'primary', T('Envoyer ce texte', 'Send this text')); go.title = T('Appuie sur Entrée dans le terminal de la session : le texte resté dans l’invite part tel quel', 'Presses Enter in the session terminal: the text left in the prompt is sent as is');
  go.onclick = () => sendKeys(it, [{ k: 'Enter' }], expect, T('texte de l’invite envoyé', 'prompt text sent'));
  const clr = el('button', null, T('Vider l’invite', 'Clear the prompt')); clr.title = T('Appuie deux fois sur Échap dans le terminal de la session : le texte est effacé, rien n’est envoyé', 'Presses Esc twice in the session terminal: the text is erased, nothing is sent');
  clr.onclick = () => sendKeys(it, [{ k: 'Esc' }, { k: 'Esc' }], expect, T('invite vidée', 'prompt cleared'));
  row.append(go, clr); c.append(row);
  c.append(el('div', 'hint', T('Tant que ce texte est dans l’invite, aucun message ne peut être envoyé à la session. Envoie-le ou vide l’invite ; le texte est revérifié à l’écran juste avant.', 'While this text is in the prompt, no message can be sent to the session. Send it or clear the prompt; the text is checked again on the screen just before.')));
  box.append(c);
}
// QUESTIONS MISES DE CÔTÉ : « Chat about this » ferme le dialogue dans le terminal, et la page n'avait alors plus rien
// à montrer — les questions et leurs options disparaissaient au moment d'en discuter. Le serveur les relit dans le
// transcript (`parked` de /api/screen) : on les garde affichées, sans rien taper dans le terminal. Cliquer une option
// la recopie dans la zone de réponse. Repliées dès qu'une réponse est partie ; remplacées par le dialogue suivant.
function parkedHidden() { try { return localStorage.getItem('cc.parked.hide'); } catch { return null; } }
function parkedPick(v, q, n, o) {
  const line = (q.header || T('Question ' + n, 'Question ' + n)) + T(' : ', ': ') + o.label;
  return v && v.trim() ? v.replace(/\s+$/, '') + '\n' + line : line;
}
function renderParked(box, p) {
  box.append(el('h2', null, T('Questions mises de côté — tu as choisi d’en discuter', 'Questions set aside — you chose to chat about them')));
  const c = el('details', 'dlg qcard parked'); c.open = !p.replies;
  c.append(el('summary', null, p.questions.length > 1 ? T(p.questions.length + ' questions et leurs options', p.questions.length + ' questions and their options') : T('La question et ses options', 'The question and its options')));
  p.questions.forEach((q, i) => {
    const blk = el('div', 'qblock');
    blk.append(el('div', 'q', (q.header ? q.header + ' — ' : '') + q.question));
    const os = el('div', 'opts');
    q.options.forEach((o, j) => {
      const b = el('button', 'opt pk'); b.type = 'button'; b.append(el('span', 'n', (j + 1) + '.'), el('span', null, o.label));
      if (o.description) b.append(el('span', 'd', o.description));
      b.title = T('Recopie ce choix dans ta réponse — rien n’est envoyé', 'Copies this choice into your reply — nothing is sent');
      b.onclick = () => { const t = $('sendtext'); if (!t || t.disabled) return; t.value = parkedPick(t.value, q, i + 1, o); t.dispatchEvent(new Event('input')); t.focus(); };
      os.append(b);
    });
    blk.append(os); c.append(blk);
  });
  const row = el('div', 'row'); const hide = el('button', null, T('Masquer', 'Hide'));
  hide.onclick = () => { try { localStorage.setItem('cc.parked.hide', p.id); } catch {} lastDialogSig = null; refreshScreen(); };
  row.append(hide); c.append(row);
  c.append(el('div', 'hint', T('« Chat about this » a fermé le dialogue dans le terminal : la session attend maintenant ton message, plus un choix. Clique une option pour la recopier dans ta réponse, ou écris librement.', '"Chat about this" closed the dialog in the terminal: the session now waits for your message, not a choice. Click an option to copy it into your reply, or write freely.')));
  box.append(c);
}
let keying = false, lastDialogSig = null;
async function sendKeys(it, keys, expect, what) {
  if (keying) return; keying = true; document.querySelectorAll('#dialog button').forEach(b => b.disabled = true);
  try {
    const r = await (await fetch(sx(it, '/api/keys?pid=' + it.pid), { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ keys, expect }) })).json();
    say(r.error ? T('non envoyé : ', 'not sent: ') + r.error : T((what || 'touche envoyée') + ' — « ' + label(it) + ' »', (what || 'key sent') + ' — "' + label(it) + '"'));
  } catch { say(T('échec de la demande', 'request failed')); }
  keying = false; lastDialogSig = null; setTimeout(refreshScreen, 350); setTimeout(refreshScreen, 1200);
}
// Session INACTIVE : deux blocages se lèvent aussi d'ici. Un DIALOGUE ouvert hors attente (plus d'invite à l'écran,
// pied « Enter to select · Esc to cancel » présent) ; une INVITE OCCUPÉE — un texte y est resté (brouillon tapé dans
// le terminal, message tapé mais jamais parti, menu « / ») et tout envoi est refusé tant qu'il y est. `draft` vient de
// /api/screen : null = pas d'invite à l'écran, '' = invite libre, sinon le texte resté.
function renderDialog(it, text, draft, parked) {
  const box = $('dialog'); if (!box) return;
  const free = it.status === 'idle' || it.status === 'shell';
  let d = it.status === 'waiting' ? parseDialog(text) : null;
  if (!d && free && draft == null) { const x = parseDialog(text); if (x && x.foot) d = x; }
  const stuck = !d && free && draft ? draft : null;
  if (stuck) { renderStuckPrompt(it, box, stuck); return; }
  const menu = !d && (it.status === 'waiting' || (free && draft == null)) ? parseKeyMenu(text) : null;
  const pk = !d && !menu && parked && parked.questions && parked.questions.length && parkedHidden() !== parked.id ? parked : null;
  const sig = d ? JSON.stringify(d) : menu ? 'menu:' + JSON.stringify(menu) : pk ? 'parked:' + JSON.stringify(pk) : '';
  if (sig === lastDialogSig && box.dataset.pid === String(it.pid)) return;
  // Ne pas écraser une saisie en cours dans le panneau.
  const act = document.activeElement; if (act && (act.tagName === 'INPUT' || act.tagName === 'TEXTAREA') && box.contains(act) && act.value) return;
  lastDialogSig = sig; box.dataset.pid = it.pid; box.replaceChildren();
  if (menu) { renderKeyMenu(it, box, menu); return; }
  if (pk) { renderParked(box, pk); return; }
  if (!d) return;
  box.append(el('h2', null, T('Dialogue en attente — réponds ici', 'Pending dialog — answer here')));
  const c = el('div', 'dlg');
  if (d.tabs) c.append(el('div', 'tabs', d.tabs));
  if (d.q) c.append(el('div', 'q', d.q));
  const os = el('div', 'opts'); let other = null;
  // Touches qui AMÈNENT sur une option : son chiffre, ou — question avec aperçu, sourde aux chiffres — les flèches
  // depuis le curseur. Le chiffre valide tout seul ; après les flèches il faut Entrée.
  const at = d.opts.findIndex(o => o.sel), arrows = d.preview && at >= 0;
  const reach = o => arrows ? Array.from({ length: Math.abs(o.num - 1 - at) }, () => ({ k: o.num - 1 > at ? 'Down' : 'Up' })) : [{ t: String(o.num) }];
  for (const o of d.opts) {
    const b = el('button', 'opt' + (o.sel ? ' sel' : '')); b.append(el('span', 'n', o.num + '.'), el('span', null, o.label));
    if (o.desc.length) b.append(el('span', 'd', o.desc.join(' ')));
    b.title = arrows ? T('Amène le curseur sur l’option ' + o.num + ' puis Entrée, dans le terminal  ( touche ' + o.num + ' )', 'Moves the cursor to option ' + o.num + ' then Enter, in the terminal  ( key ' + o.num + ' )')
      : T('Tape « ' + o.num + ' » dans le terminal  ( touche ' + o.num + ' )', 'Types "' + o.num + '" into the terminal  ( key ' + o.num + ' )');
    if (!d.multi && /^(type something|other|autre)/i.test(o.label)) other = o;
    b.onclick = () => sendKeys(it, arrows ? reach(o).concat([{ k: 'Enter' }]) : reach(o), o.expect, T('option ' + o.num + ' « ' + o.label + ' »', 'option ' + o.num + ' "' + o.label + '"'));
    os.append(b);
  }
  c.append(os);
  // Choix multiple : le chiffre coche / décoche ; « Submit » se valide à part. Avec plusieurs questions, → mène à
  // l'onglet Submit (récapitulatif) ; sinon on descend du curseur jusqu'à la ligne Submit puis Entrée.
  if (d.multi && d.submit) {
    const cur = Math.max(0, d.opts.findIndex(o => o.sel)), last = d.opts.map(o => /^\[[ ✔xX]\]/.test(o.label)).lastIndexOf(true);
    const keys = d.tabs ? [{ k: 'Right' }] : Array.from({ length: last - cur + 1 }, () => ({ k: 'Down' })).concat([{ k: 'Enter' }]);
    const row = el('div', 'row'); const b = el('button', 'primary', d.tabs ? T('Valider la sélection → question suivante', 'Confirm the selection → next question') : T('Valider la sélection', 'Confirm the selection'));
    b.title = T('Le chiffre d’une option la coche ou la décoche ; ce bouton valide les cases cochées', 'An option’s number checks or unchecks it; this button confirms the checked boxes');
    b.onclick = () => sendKeys(it, keys, d.opts[cur].expect, T('sélection validée', 'selection confirmed')); row.append(b); c.append(row);
  }
  if (other) {
    const row = el('div', 'row'); const inp = promptArea('dlgother'); inp.placeholder = T('Ta réponse libre (option ' + other.num + ')… — Entrée pour envoyer · Maj+Entrée : à la ligne', 'Your free answer (option ' + other.num + ')… — Enter to send · Shift+Enter: new line'); inp.maxLength = 4000;
    const go = el('button', 'primary', T('Envoyer la réponse libre', 'Send the free answer'));
    const fire = () => { const v = inp.value.trim(); if (!v) return; inp.value = ''; growArea(inp); inp.blur(); sendKeys(it, reach(other).concat([{ t: v }, { k: 'Enter' }]), other.expect, T('réponse libre', 'free answer')); };
    go.onclick = fire; inp.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fire(); } else if (e.key === 'Escape') inp.blur(); };
    row.append(inp, go); c.append(row);
  }
  const kr = el('div', 'row keys');
  for (const [k, t, h] of [['Up', '↑', T('Monter', 'Up')], ['Down', '↓', T('Descendre', 'Down')], ['Space', T('Espace', 'Space'), T('Cocher / décocher (choix multiple)', 'Check / uncheck (multiple choice)')], ['Enter', T('Entrée', 'Enter'), T('Valider', 'Confirm')], ['Left', '←', T('Question précédente', 'Previous question')], ['Right', '→', T('Question suivante / Submit', 'Next question / Submit')], ['Tab', 'Tab', T('Champ suivant', 'Next field')], ['Esc', T('Échap', 'Esc'), T('Annuler le dialogue', 'Cancel the dialog')]]) {
    // Hors attente, le serveur n'accepte une touche qu'avec un texte à retrouver à l'écran : la première option.
    const b = el('button', null, t); b.title = h; b.onclick = () => sendKeys(it, [{ k }], it.status === 'waiting' ? null : d.opts[0].expect, t); kr.append(b);
  }
  c.append(kr);
  c.append(el('div', 'hint', (d.foot ? T('Dans le terminal : ', 'In the terminal: ') + d.foot + '. ' : '') + T('Chaque clic est tapé dans le terminal de la session ; l’option visée est revérifiée à l’écran juste avant. Touches 1 à 9 : choisir une option.', 'Each click is typed into the session terminal; the target option is checked again on the screen just before. Keys 1 to 9: pick an option.')));
  box.append(c);
}

// ───────────── Conversation complète : le transcript de la session (/api/transcript) ─────────────
// Le terminal ne garde que son tampon : pour relire le début d'une longue session, on lit son transcript .jsonl.
// Chargé par tranches depuis la fin (« plus ancien » remonte), puis suivi à chaque passe pour une session ouverte.
let conv = null;   // { key, id, items, start, end, more, busy, err } — celle de la session affichée
const convTools = () => localStorage.getItem('cc.convtools') !== '0';
// Sans choix mémorisé : la conversation sur téléphone (l'écran du terminal y est peu lisible), l'écran ailleurs.
const convView = () => { const v = localStorage.getItem('cc.view'); return v === 'conv' || v === 'screen' ? v : NARROW.matches ? 'conv' : 'screen'; };
// Écran étroit : les filets du terminal (─── sur toute la largeur) replieraient en plusieurs lignes : raccourcis.
const screenText = t => NARROW.matches ? t.replace(/[─━═▔▁]{24,}/g, m => m.slice(0, 24)) : t;
function convPane() {
  const w = el('div', 'conv'); w.id = 'conv';
  const bar = el('div', 'convbar');
  const lb = el('label'), cb = el('input'); cb.type = 'checkbox'; cb.checked = convTools();
  cb.onchange = () => { localStorage.setItem('cc.convtools', cb.checked ? '1' : '0'); drawConv(); };
  lb.append(cb, T(' outils et résultats', ' tools and results'));
  const end = el('button', 'quick', T('↓ fin', '↓ end')); end.title = T('Aller au dernier message', 'Go to the last message'); end.onclick = () => { const l = $('convlist'); if (l) l.scrollTop = l.scrollHeight; };
  const st = el('span', 'meta'); st.id = 'convstat';
  bar.append(lb, end, st);
  const list = el('div', 'convlist', '…'); list.id = 'convlist';
  w.append(bar, list); return w;
}
function setConvView(v) {
  localStorage.setItem('cc.view', v);
  const it = selected && byKey(selected); if (it) applyConvView(it);
}
function applyConvView(it) {
  const pre = $('screen'), w = $('conv'); if (!w) return;
  const v = pre ? convView() : 'conv';
  if (pre) pre.hidden = v !== 'screen';
  w.hidden = v !== 'conv';
  document.querySelectorAll('.viewtabs .vtab').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  if (v === 'conv') loadConv(it, 'init');
}
async function loadConv(it, mode) {
  if (!$('convlist') || !it || !it.sessionId) return;
  if (!conv || conv.key !== it.key || conv.id !== it.sessionId) conv = { key: it.key, id: it.sessionId, machine: it.machine || null, items: [], start: null, end: null, more: false, busy: false, err: null };
  const c = conv;
  c.phase = it.kind === 'run' && it.run ? it.run.phase : null;     // conversation d'un run : ses messages ont un auteur précis
  if (mode === 'init' && c.end != null) { drawConv(true); return; }      // déjà chargée : on revient dessus
  if (mode === 'more' && c.end == null) mode = 'init';
  if (c.busy) return; c.busy = true;
  try {
    const url = sx(it, '/api/transcript?id=' + encodeURIComponent(c.id)) + (mode === 'older' ? '&before=' + c.start : mode === 'more' ? '&after=' + c.end : '');
    const res = await fetch(url, { cache:'no-store' }); const r = await res.json();
    if (conv !== c) return;
    if (!res.ok) { c.err = r.error || (T('erreur ', 'error ') + res.status); drawConv(); return; }
    c.err = null;
    if (r.reset) { c.items = []; c.start = c.end = null; return; }          // transcript réécrit ou trop de retard : rechargé à la passe suivante
    if (mode === 'older') { c.items = r.items.concat(c.items); c.start = r.start; c.more = r.start > 0; drawConv(false, true); }
    else if (mode === 'more') { c.end = r.end; if (r.items.length) { c.items = c.items.concat(r.items); drawConv(); } }
    else { c.items = r.items; c.start = r.start; c.end = r.end; c.more = r.start > 0; drawConv(true); }
  } catch { if (conv === c) { c.err = T('transcript illisible (serveur injoignable ?)', 'transcript unreadable (server unreachable?)'); drawConv(); } }
  finally { c.busy = false; }
}
const convWhen = at => {
  const d = new Date(at); if (isNaN(d)) return '';
  const hm = d.toLocaleTimeString(LOCALE, { hour:'2-digit', minute:'2-digit' });
  return d.toDateString() === new Date().toDateString() ? hm : d.toLocaleDateString(LOCALE, { day:'2-digit', month:'2-digit' }) + ' ' + hm;
};
// ── Markdown des messages de Claude ──
// Les réponses de Claude sont écrites en markdown : affichées en texte brut, on lisait des ** et des ` partout.
// Analyse PURE (texte -> arbre, testée sous node par sessions-dashboard-tests.ps1), puis construction DOM par
// createElement/textContent : jamais d'innerHTML, un transcript ne peut donc pas injecter de HTML. Liens : http(s) seuls.
// Sous-ensemble utile : titres, paragraphes, listes (puces, numérotées, imbriquées), citations, blocs de code,
// tableaux, filets ; en ligne : gras, italique, barré, code, liens [texte](url) et URL nues.
function mdInline(s) {
  const out = []; let buf = '', i = 0, m;
  const flush = () => { if (buf) { out.push({ k:'t', t:buf }); buf = ''; } };
  while (i < s.length) {
    const r = s.slice(i), c = r[0];
    if (c === '\\' && /^[\\`*_[\]~#>|()-]$/.test(r[1] || '')) { buf += r[1]; i += 2; continue; }
    if (c === '`' && (m = /^(`+)(?!`)([\s\S]*?[^`])\1(?!`)/.exec(r))) { flush(); out.push({ k:'code', t:m[2].replace(/^ ([\s\S]*) $/, '$1') }); i += m[0].length; continue; }
    if (c === '*' && (m = /^\*\*(?=\S)([\s\S]*?\S)\*\*/.exec(r))) { flush(); out.push({ k:'b', c:mdInline(m[1]) }); i += m[0].length; continue; }
    if (c === '_' && !/\w$/.test(buf) && (m = /^__(?=\S)([\s\S]*?\S)__(?!\w)/.exec(r))) { flush(); out.push({ k:'b', c:mdInline(m[1]) }); i += m[0].length; continue; }
    if (c === '~' && (m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(r))) { flush(); out.push({ k:'s', c:mdInline(m[1]) }); i += m[0].length; continue; }
    if (c === '*' && (m = /^\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/.exec(r))) { flush(); out.push({ k:'i', c:mdInline(m[1]) }); i += m[0].length; continue; }
    if (c === '_' && !/\w$/.test(buf) && (m = /^_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/.exec(r))) { flush(); out.push({ k:'i', c:mdInline(m[1]) }); i += m[0].length; continue; }
    if (c === '[' && (m = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/.exec(r))) { flush(); out.push({ k:'a', href:m[2], c:mdInline(m[1]) }); i += m[0].length; continue; }
    if (c === 'h' && !/\w$/.test(buf) && (m = /^https?:\/\/[^\s<>()`"]+/.exec(r))) {
      const url = m[0].replace(/[.,;:!?'»*]+$/, ''); flush(); out.push({ k:'a', href:url, c:[{ k:'t', t:url }] }); i += url.length; continue;
    }
    buf += c; i++;
  }
  flush(); return out;
}
function mdBlocks(text) {
  const L = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n'), out = []; let i = 0, m;
  const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/, HEAD = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/, HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const LI = /^(\s*)([-*+]|\d{1,4}[.)])\s+(.*)$/, QUOTE = /^\s{0,3}>/;
  const SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const isTable = j => L[j].includes('|') && j + 1 < L.length && SEP.test(L[j + 1]) && L[j + 1].includes('-');
  const cells = l => l.trim().replace(/^\|/, '').replace(/(^|[^\\])\|$/, '$1').split(/(?<!\\)\|/).map(x => mdInline(x.trim().replace(/\\\|/g, '|')));
  const starts = j => FENCE.test(L[j]) || HEAD.test(L[j]) || HR.test(L[j]) || LI.test(L[j]) || QUOTE.test(L[j]) || isTable(j);
  while (i < L.length) {
    const l = L[i];
    if (!l.trim()) { i++; continue; }
    if ((m = FENCE.exec(l))) {
      const fence = m[1], body = []; i++;
      while (i < L.length && !L[i].trim().startsWith(fence)) body.push(L[i++]);
      i++; out.push({ k:'code', lang:m[2], t:body.join('\n') }); continue;
    }
    if ((m = HEAD.exec(l))) { out.push({ k:'h', lv:m[1].length, in:mdInline(m[2]) }); i++; continue; }
    if (HR.test(l)) { out.push({ k:'hr' }); i++; continue; }
    if (isTable(i)) {
      const head = cells(l), rows = []; i += 2;
      while (i < L.length && L[i].trim() && L[i].includes('|')) rows.push(cells(L[i++]));
      out.push({ k:'table', head, rows }); continue;
    }
    if (QUOTE.test(l)) {
      const q = []; while (i < L.length && QUOTE.test(L[i])) q.push(L[i++].replace(/^\s{0,3}> ?/, ''));
      out.push({ k:'quote', c:mdBlocks(q.join('\n')) }); continue;
    }
    if (LI.test(l)) {
      const items = [], base = LI.exec(l)[1].length;
      while (i < L.length) {
        const x = LI.exec(L[i]);
        if (x) { items.push({ lv:Math.max(0, Math.floor((x[1].replace(/\t/g, '    ').length - base) / 2)), o:/\d/.test(x[2]) ? parseInt(x[2], 10) : null, t:x[3] }); i++; }
        else if (items.length && L[i].trim() && /^\s+\S/.test(L[i]) && !starts(i)) { items[items.length - 1].t += '\n' + L[i].trim(); i++; }
        else break;
      }
      out.push({ k:'list', items:items.map(x => ({ lv:Math.min(x.lv, 6), o:x.o, in:mdInline(x.t) })) }); continue;
    }
    const p = [l]; i++;
    while (i < L.length && L[i].trim() && !starts(i)) p.push(L[i++]);
    out.push({ k:'p', in:mdInline(p.join('\n')) });
  }
  return out;
}
// ── fin de l'analyse markdown ──
function mdInlineNodes(parent, toks) {
  for (const t of toks) {
    if (t.k === 't') parent.append(t.t);
    else if (t.k === 'code') parent.append(el('code', null, t.t));
    else if (t.k === 'a') { const a = el('a'); a.href = t.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = t.href; parent.append(mdInlineNodes(a, t.c)); }
    else parent.append(mdInlineNodes(el(t.k === 'b' ? 'strong' : t.k === 'i' ? 'em' : 'del'), t.c));
  }
  return parent;
}
function mdBlockNode(b) {
  switch (b.k) {
    case 'h': return mdInlineNodes(el('div', 'mdh mdh' + b.lv), b.in);
    case 'hr': return el('hr');
    case 'code': { const pre = el('pre', 'mdcode'); pre.append(el('code', null, b.t)); return pre; }
    case 'quote': { const q = el('blockquote'); for (const x of b.c) q.append(mdBlockNode(x)); return q; }
    case 'list': {
      const w = el('div', 'mdlist');
      for (const it of b.items) {
        const li = el('div', 'mdli'); li.style.marginLeft = (it.lv * 1.2) + 'em';
        li.append(el('span', 'mdmark', it.o != null ? it.o + '.' : it.lv ? '◦' : '•'), mdInlineNodes(el('span', 'mdlitx'), it.in));
        w.append(li);
      }
      return w;
    }
    case 'table': {
      const wrap = el('div', 'mdtable'), tb = el('table'), hr = el('tr');
      for (const c of b.head) hr.append(mdInlineNodes(el('th'), c));
      tb.append(hr);
      for (const r of b.rows) { const tr = el('tr'); for (const c of r) tr.append(mdInlineNodes(el('td'), c)); tb.append(tr); }
      wrap.append(tb); return wrap;
    }
    default: return mdInlineNodes(el('p'), b.in);
  }
}
// Arbre gardé sur le message : drawConv redessine toute la liste à chaque passe.
function mdRender(m) {
  const root = el('div', 'tx md');
  try { for (const b of (m.md || (m.md = mdBlocks(m.t)))) root.append(mdBlockNode(b)); }
  catch (e) { console.log('[sessions] markdown :', e); root.className = 'tx'; root.textContent = m.t; }
  return root;
}
// Dernier message hors conversation (carte de survol, automate sans terminal) : même rendu markdown, dans un cadre.
function mdBody(cls, text) { const w = el('div', cls); w.append(mdRender({ t:text })); return w; }
// ── Images citées par chemin ──
// Claude écrit « Captures : `C:\…\capture.png` » : la vignette s'affiche sous le message, un clic l'agrandit. Le
// fichier est lu par /api/image (images d'un disque local seulement, contenu vérifié). PURE (testée) : texte ->
// chemins absolus d'images, dans l'ordre du texte, sans doublon, 8 au plus. Entre ` `, " " ou « » le chemin peut
// contenir des espaces ; nu, il s'arrête au premier blanc. Jamais un partage réseau (\\serveur\…).
function imagePaths(text) {
  const s = String(text == null ? '' : text), found = [];
  const ok = p => /^(?:[A-Za-z]:[\\/]|\/(?!\/))[^\n"<>|?*]*\.(?:png|jpe?g|gif|webp|bmp)$/i.test(p) && !p.slice(2).includes(':');   // « : » plus loin = flux NTFS
  for (const m of s.matchAll(/`([^`\n]+)`|"([^"\n]+)"|«\s*([^»\n]+?)\s*»/g)) { const p = (m[1] || m[2] || m[3]).trim(); if (ok(p)) found.push([m.index, p]); }
  for (const m of s.matchAll(/(^|[\s(\[=])([A-Za-z]:[\\/][^\s"'`<>|?*]*?\.(?:png|jpe?g|gif|webp|bmp))(?=$|[\s)\],;!?'"»]|[.:](?:\s|$))/gim)) if (ok(m[2])) found.push([m.index + m[1].length, m[2]]);
  found.sort((a, b) => a[0] - b[0]);
  const out = [], seen = new Set();
  for (const [, p] of found) { const k = p.toLowerCase(); if (!seen.has(k) && out.length < 8) { seen.add(k); out.push(p); } }
  return out;
}
const imgUrl = p => sx(conv && conv.machine ? { machine: conv.machine } : null, '/api/image?path=' + encodeURIComponent(p));   // image citée par une session d'un autre poste : lue là-bas
const imgBad = new Set();   // illisibles (capture purgée…) : plus redessinées, sinon chaque lecture ferait sauter la liste
function convImages(text) {
  const paths = imagePaths(text).filter(p => !imgBad.has(p)); if (!paths.length) return null;
  const w = el('div', 'cimgs');
  for (const p of paths) {
    const f = el('figure', 'cimg'), img = el('img'), name = p.split(/[\\/]/).pop();
    img.src = imgUrl(p); img.alt = name; img.title = p + T(' — clic : agrandir', ' — click: enlarge'); img.decoding = 'async';
    img.onerror = () => { imgBad.add(p); f.remove(); if (!w.childElementCount) w.remove(); };
    img.onclick = () => openImage(p);
    f.append(img, el('figcaption', null, name)); w.append(f);
  }
  return w;
}
function openImage(p) {
  document.querySelector('.imgview')?.remove();
  const o = el('div', 'imgview'), bar = el('div', 'imgbar'), a = el('a', null, T('ouvrir dans un onglet', 'open in a tab')), x = el('button', 'quick', '✕'), img = el('img');
  a.href = imgUrl(p); a.target = '_blank'; a.rel = 'noopener';
  img.src = imgUrl(p); img.alt = p;
  bar.append(el('span', 'ipath', p), a, x); o.append(bar, img);
  const close = () => { o.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  o.onclick = e => { if (e.target !== a && !bar.contains(e.target) || e.target === x) close(); };
  document.addEventListener('keydown', onKey, true);
  document.body.append(o);
}
// ── Provenance des messages ──
// Tout ce qui porte le rôle « user » n'est pas tapé par la personne, et « assistant » n'est pas toujours la session
// qu'on pilote : la consigne d'un run vient de l'orchestrateur, sa réponse de l'agent de cette étape (diagnostic,
// développement, relecture…), une fin de tâche de fond de Claude Code lui-même. Chaque provenance a son libellé et sa
// couleur. PURE (testée) : m = élément de /api/transcript (m.o = provenance lue par le serveur), phase = étape du run
// dont on lit la conversation (null pour une session ordinaire).
const AGENT_FR = { diagnostic:T('Agent de diagnostic', 'Diagnosis agent'), suite:T('Agent de diagnostic · suite', 'Diagnosis agent · follow-up'), relance:T('Agent de diagnostic · relance', 'Diagnosis agent · restart'), reveil:T('Agent de diagnostic · réveil', 'Diagnosis agent · wake-up'),
  dev:T('Agent de développement', 'Development agent'), reprise:T('Agent de développement · reprise', 'Development agent · resume'), relecture:T('Agent de relecture', 'Review agent'), recette:T('Agent de recette', 'Testing agent') };
const AGENT_KIND = { diagnostic:'diag', suite:'diag', relance:'diag', reveil:'diag', dev:'dev', reprise:'dev', relecture:'review', recette:'recette' };
function convOrigin(m, phase) {
  if (m.r === 'assistant') return phase ? { cls: 'agent ag-' + (AGENT_KIND[phase] || 'other'), who: '🤖 ' + (AGENT_FR[phase] || T('Agent du lanceur · ', 'Launcher agent · ') + phase) } : { cls: '', who: 'Claude' };
  const t = String(m.t == null ? '' : m.t).trim(); let x;
  if (m.o === 'task' || /^<task-notification>[\s\S]*<\/task-notification>$/.test(t)) {
    const unesc = v => v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    const st = /<status>([^<]*)<\/status>/.exec(t); x = /<summary>([\s\S]*?)<\/summary>/.exec(t);
    return { cls: 'task', who: T('⚙ Tâche de fond', '⚙ Background task'), text: x ? unesc(x[1]).trim() : t, err: !!st && st[1].trim() !== 'completed' };
  }
  if (m.o === 'sdk') return { cls: 'auto', who: phase ? T('🤖 Lanceur · consigne du run', '🤖 Launcher · run instructions') : T('🤖 Automate · consigne de lancement', '🤖 Automation · start instructions') };
  if ((x = /^<pasted_content[^>]*>\n?([\s\S]*?)\n?<\/pasted_content>$/.exec(t)) && !x[1].includes('<pasted_content')) return { cls: 'paste', who: T('📋 Collé dans la session', '📋 Pasted into the session'), text: x[1] };
  return { cls: '', who: T('Toi', 'You') };
}
function convItem(m) {
  if (m.r === 'tool') {
    const d = el('div', 'cm tool'); const lines = m.t.split('\n');
    d.append(el('span', 'tn', '⚙ ' + m.n), el('span', 'tx', ' ' + lines[0])); if (lines.length > 1) d.title = m.t;
    return d;
  }
  if (m.r === 'result' || m.r === 'summary') {
    const d = el('details', 'cm ' + (m.r === 'summary' ? 'sum' : 'res') + (m.e ? ' err' : ''));
    const first = (m.t.split('\n').find(l => l.trim()) || T('(vide)', '(empty)')).trim();
    d.append(el('summary', null, (m.r === 'summary' ? T('📋 Résumé de compactage — ', '📋 Compaction summary — ') : (m.e ? '✗ ' : '↳ ')) + (first.length > 160 ? first.slice(0, 160) + '…' : first)), el('pre', null, m.t));
    return d;
  }
  const og = convOrigin(m, conv ? conv.phase : null), when = m.at ? ' · ' + convWhen(m.at) : '';
  if (og.cls === 'task') {     // une ligne repliée, comme un résultat d'outil : le détail brut reste à un clic
    const d = el('details', 'cm res task' + (og.err ? ' err' : ''));
    d.append(el('summary', null, og.who + when + ' — ' + (og.text.length > 160 ? og.text.slice(0, 160) + '…' : og.text)), el('pre', null, m.t));
    return d;
  }
  const d = el('div', 'cm ' + m.r + (og.cls ? ' ' + og.cls : ''));
  d.append(el('div', 'who', og.who + when), m.r === 'assistant' ? mdRender(m) : el('div', 'tx', og.text != null ? og.text : m.t));
  const imgs = convImages(og.text != null ? og.text : m.t); if (imgs) d.append(imgs);
  return d;
}
function drawConv(toBottom, keepTop) {
  const list = $('convlist'), c = conv; if (!list || !c) return;
  if (String(getSelection()) && list.contains(getSelection().anchorNode) && !toBottom && !keepTop) return;   // ne pas casser une sélection en cours
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60, oldH = list.scrollHeight, oldTop = list.scrollTop;
  const tools = convTools(), shown = c.items.filter(m => tools || (m.r !== 'tool' && m.r !== 'result'));
  const frag = document.createDocumentFragment();
  if (c.more) { const b = el('button', 'quick older', T('↑ charger plus ancien', '↑ load older')); b.onclick = () => { const it = byKey(c.key); if (it) loadConv(it, 'older'); }; frag.append(b); }
  else if (c.end != null) frag.append(el('div', 'meta convtop', T('— début de la conversation —', '— start of the conversation —')));
  if (c.err) frag.append(el('div', 'empty', c.err));
  else if (c.end != null && !shown.length) frag.append(el('div', 'empty', c.more ? T('Rien à afficher dans ce dernier morceau du transcript : charge plus ancien.', 'Nothing to show in this last part of the transcript: load older.') : T('Aucun message.', 'No message.')));
  for (const m of shown) frag.append(convItem(m));
  list.replaceChildren(frag);
  const st = $('convstat'); if (st) st.textContent = c.end == null ? '' : plural(shown.length, 'message', 'messages') + (c.more ? T(' · transcript lu depuis ' + Math.round((c.end - c.start) / 1024).toLocaleString(LOCALE) + ' Ko de la fin', ' · transcript read from the last ' + Math.round((c.end - c.start) / 1024).toLocaleString(LOCALE) + ' KB') : T(' · conversation entière', ' · whole conversation'));
  if (toBottom || (atBottom && !keepTop)) list.scrollTop = list.scrollHeight;
  else if (keepTop) list.scrollTop = oldTop + (list.scrollHeight - oldH);
}
function refreshConv() {
  const it = pickRun(selected && byKey(selected)), w = $('conv');
  if (it && w && !w.hidden && (isLive(it) || (it.kind === 'run' && it.run.running) || (it.kind === 'pass' && it.running)) && conv && conv.key === it.key && conv.id === it.sessionId && conv.end != null) loadConv(it, 'more');
}

async function refreshScreen() {
  const it = selected && byKey(selected); const pre = $('screen');
  if (!isLive(it) || !pre) return;
  try {
    const r = await (await fetch(sx(it, '/api/screen?pid=' + it.pid), { cache:'no-store' })).json();
    if (selected !== it.key) return;
    const text = r.text == null ? T('(écran illisible : la session n\'est pas dans une console accessible)', '(screen unreadable: the session is not in an accessible console)') : r.text;
    if (text !== lastScreen && !String(getSelection())) { lastScreen = text; pre.textContent = screenText(text); pre.scrollTop = pre.scrollHeight; }
    renderDialog(it, r.text || '', r.draft, r.parked || null);
    renderSuggest(it, r.suggestion || null);
  } catch {}
}

async function loadClosed() { try { closedData = await (await fetch('/api/closed', { cache:'no-store' })).json(); if (data) { renderList(); renderDetail(); } } catch {} }
// ───── Lien avec le serveur : coupure, reconnexion, redémarrage ─────
// Le serveur annonce dans /api/state l'identifiant de SON démarrage (boot) et l'empreinte des fichiers de la page
// (page). Coupure ⇒ bandeau « reconnexion en cours », actions suspendues, la lecture continue toutes les 2 s.
// Retour ⇒ démarrage différent : resynchronisation complète ; page différente : rechargement (différé si une
// saisie est en cours, pour ne rien perdre).
// Saisie en cours = un champ rempli qui a le focus, le formulaire de nouvelle session ou d'envoi groupé, ou une pièce
// jointe en attente (non gardée). Un brouillon de réponse seul n'empêche plus le rechargement : il est gardé.
function typing() {
  const a = document.activeElement;
  return !!(newMode || bcMode || Object.values(attachSets).some(l => l.length)
    || (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'search')) && a.value));
}
function drawLink() {
  const b = $('offline'); if (!b) return;
  document.body.classList.toggle('offline', !!link.down);
  if (link.down) {
    const s = Math.round((Date.now() - link.down.since) / 1000);
    b.className = 'down'; b.hidden = false;
    b.replaceChildren(el('b', null, T('⟳ Serveur injoignable — reconnexion en cours…', '⟳ Server unreachable — reconnecting…')),
      el('span', null, T(' depuis ' + (s < 90 ? s + ' s' : Math.round(s / 60) + ' min') + ' · la page reprend seule dès qu’il répond ; les actions sont suspendues', ' for ' + (s < 90 ? s + ' s' : Math.round(s / 60) + ' min') + ' · the page resumes on its own as soon as it answers; actions are paused')
        + (s >= 120 ? T(' · toujours rien : le serveur a-t-il été relancé ?', ' · still nothing: has the server been restarted?') : '') + (link.down.why ? ' (' + link.down.why + ')' : '')));
  } else if (link.reload) {
    const go = el('button', null, T('Recharger', 'Reload'));
    go.onclick = () => location.reload();
    b.className = 'reload'; b.hidden = false;
    b.replaceChildren(el('b', null, T('↻ Serveur redémarré avec une nouvelle version de la page', '↻ Server restarted with a new version of the page')), el('span', null, T(' — rechargement dès la saisie terminée, ou maintenant : ', ' — reloading once you finish typing, or now: ')), go);
  } else b.hidden = true;
}
/** Une lecture d'état réussie : compare le démarrage et la page à ceux qu'on connaissait. */
function linkUp(srv) {
  const wasDown = link.down; link.down = null;
  const boot = srv && srv.boot, page = srv && srv.page;
  const restarted = !!(link.boot && boot && boot !== link.boot), newPage = !!(link.page && page && page !== link.page);
  if (!link.boot) { link.boot = boot || null; link.page = page || null; }
  if (newPage || link.reload) {
    link.reload = true;
    if (!typing()) { location.reload(); return true; }
  } else if (restarted || wasDown) {
    link.boot = boot || link.boot;
    tagVocab = null; loadClosed(); loadRuns(); loadAutomations();
    if (REMOTE) whoami();
    say(restarted ? T('serveur redémarré — page resynchronisée', 'server restarted — page resynced') : T('reconnecté au serveur', 'reconnected to the server'));
  }
  drawLink(); return false;
}
function linkDown(why) {
  if (!link.down) { link.down = { since: Date.now(), tries: 0, why: '' }; console.log('[sessions] serveur injoignable :', why); }
  link.down.tries++; link.down.why = why; drawLink();
}
// Seul l'échec de la LECTURE d'état dit « serveur injoignable ». Une exception du rendu qui suit est un bug de la
// page : elle est journalisée et signalée comme telle — confondue avec une coupure, elle affichait le bandeau rouge
// à chaque passe alors que le serveur répondait.
async function tick() {
  const live = $('live'); ticking = true;
  let srv;
  try {
    const r = await fetch('/api/state', { cache:'no-store', signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error('réponse ' + r.status);
    srv = await r.json();
  } catch (e) {
    linkDown(e && e.name === 'TimeoutError' ? T('pas de réponse en 25 s', 'no answer within 25 s') : e && /^réponse /.test(e.message) ? e.message : '');
    live.className = 'down'; live.textContent = T('reconnexion…', 'reconnecting…');
    ticking = false; return;
  }
  try {
    data = srv; skew = data.now ? Date.now() - data.now : 0; adoptPostLanguage(data.ui && data.ui.language); cfgErr(data.configError, data.configWarnings, data.configErrorKept, data.configRestart); favs = new Set(data.favs || []); hiddenSet = new Set(data.hidden || []); $('launchbtn').hidden = launcherOff(); chatsBadge();
    if (linkUp(data.server)) return;
    renderList(); renderDetail(); refreshScreen(); refreshConv(); try { renderQuota(); } catch (e) { console.log('[sessions] quota :', e); }
    renderRelay(data.server && data.server.relay);
    if (pendingRoute) { const r = pendingRoute; pendingRoute = null; applyRoute(r); }      // ?view= : écran d'arrivée, une fois l'état connu
    if (pendingRun && runData) { const hd = pendingRun; pendingRun = null; openRun(hd); }   // ?run= : runs arrivés avant l'état
    if (!autoAsked && !automationsOff()) loadAutomations();                               // module annoncé par l'état : première lecture
    live.className = ''; if (!notice) live.textContent = T('à jour · ', 'up to date · ') + new Date().toLocaleTimeString(LOCALE);
  } catch (e) {
    console.error('[sessions] erreur de rendu :', e);
    live.className = 'down'; live.textContent = T('erreur d’affichage (console) · ', 'display error (console) · ') + (e && e.message || e);
  } finally { ticking = false; }
}

function move(delta) {
  if (!flat.length) return;
  const i = flat.indexOf(selected);
  select(flat[Math.max(0, Math.min(flat.length - 1, i < 0 ? (delta > 0 ? 0 : flat.length - 1) : i + delta))], true);
}
document.addEventListener('keydown', e => {
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#newform')) {   // dans le formulaire : Ctrl+Entrée / Échap seulement
    if (e.key === 'Escape') { e.preventDefault(); closeNew(); } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); launchNew(); }
    else if (e.key.toLowerCase() === 's' && (e.ctrlKey || e.metaKey) && !e.altKey) { e.preventDefault(); saveDraft(); }
    return;
  }
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#bcform')) {    // message groupé : Ctrl+Entrée / Échap seulement
    if (e.key === 'Escape') { e.preventDefault(); closeBc(); } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendBc(); }
    return;
  }
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest('.cpick')) {   // choix de la session d'un fil : Entrée / Échap seulement
    if (e.key === 'Escape') { e.preventDefault(); chatPickClose(); renderChats(); }
    else if (e.key === 'Enter' && document.activeElement.tagName === 'INPUT' && document.activeElement.type === 'text') { e.preventDefault(); const s = document.activeElement.closest('.cpick').querySelector('select'); chatLink(chatPicking, 'attach', s.value); }
    return;
  }
  if (chatTyping()) {                                                              // réponse à une conversation Teams : Ctrl+Entrée / Échap seulement
    const id = document.activeElement.closest('.creply').dataset.chat;
    if (e.key === 'Escape') { e.preventDefault(); chatReplying.delete(id); renderChats(); } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); chatSend(id); }
    return;
  }
  if (document.activeElement && document.activeElement.id === 'sendtext') {       // dans la zone de réponse : rien d'autre que Entrée / Échap
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); } else if (e.key === 'Escape') document.activeElement.blur();
    else if (e.key === 'Tab' && !e.shiftKey && !document.activeElement.value && suggestion && suggestKey === selected) { if (fillSuggestion()) e.preventDefault(); }
    return;
  }
  if (document.activeElement && document.activeElement.id === 'dlgother') return;   // réponse libre : gérée par son champ
  const inSearch = document.activeElement === $('q');
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Escape') { if ($('q').value) { $('q').value = ''; renderList(); scheduleFind(); } else if (inSearch) $('q').blur(); else if (selected) select(null); else setPane(false); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1); return; }
  if (e.key === 'Enter') { let it = selected && flat.includes(selected) && byKey(selected); if (!it && inSearch && flat.length) { select(flat[0], true); it = byKey(flat[0]); } if (it) primary(it); return; }
  if (inSearch) return;
  if (e.key === '/') { e.preventDefault(); $('q').focus(); $('q').select(); }
  else if (e.key === 'n') { const todo = allItems().filter(it => TODO.includes(it.state)).sort((a, b) => TODO.indexOf(a.state) - TODO.indexOf(b.state) || a.since - b.since);
    if (!todo.length) { say(T('rien à traiter', 'nothing to handle')); return; } const i = todo.findIndex(it => it.key === selected); const it = todo[(i + 1) % todo.length]; select(it.key, true); openTab(it); }
  else if (e.key === 'f') { const it = selected && byKey(selected); if (it && it.kind !== 'run') toggleFav(it); }
  else if (/^[1-9]$/.test(e.key) && $('dialog') && $('dialog').querySelectorAll('button.opt:not(.pk)')[+e.key - 1]) { e.preventDefault(); $('dialog').querySelectorAll('button.opt:not(.pk)')[+e.key - 1].click(); }
  else if (e.key === 'p' && suggestion && suggestKey === selected) { if (fillSuggestion()) e.preventDefault(); }
  else if (e.key === 'r') { const i = $('sendtext'); if (i && !i.disabled) { e.preventDefault(); i.focus(); } }
  else if (e.key === 'c') { const it = selected && byKey(selected); if (it) copyCmd(it); }
  else if (e.key === 'b') back();
  else if (e.key === 'h') { const it = selected && byKey(selected); if (it && $('screen')) setConvView(convView() === 'conv' ? 'screen' : 'conv'); else if ($('conv')) $('conv').scrollIntoView({ block:'start' }); }
  else if (e.key === 'x') { const it = selected && byKey(selected); if (it && it.kind !== 'run') it.kind === 'closed' ? setHidden([it], !it.hidden) : closeSession(it); }
  else if (e.key === '+') { e.preventDefault(); newMode ? closeNew() : openNew(); }
  else if (e.key === 'd') { const it = selected && byKey(selected); if (it && !it.headless && it.kind !== 'peer') { e.preventDefault(); openNew({ sessionId: it.sessionId, title: it.title, cwd: it.cwd, tags: it.tags }); } }
  else if (e.key === 't') { boardMode ? closeBoard() : openBoard(); }
  else if (e.key === 'l') { launchMode ? closeLauncher() : openLauncher(); }
  else if (e.key === 'm') { chatsMode ? closeChats() : openChats(); }
});
// ── Copie à la sélection (comme le terminal de Claude Code) ──
// Relâcher la souris sur une sélection non vide la copie dans le presse-papier : écran du terminal, conversation,
// derniers prompts, n'importe quel texte de la page. Pas dans un champ de saisie (on y sélectionne pour corriger).
// Les lignes de l'écran du terminal sont complétées d'espaces jusqu'à la largeur de la console : on les retire.
function selectionToCopy(text) {
  const t = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/[ \t\u00a0]+$/gm, '');
  return t.trim() ? t.replace(/^\n+|\n+$/g, '') : '';
}
document.addEventListener('mouseup', e => {
  if (e.button !== 0) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !/^(button|checkbox|radio)$/.test(a.type)))) return;
  setTimeout(() => {                                       // après le double/triple-clic : la sélection est alors complète
    const sel = getSelection(), text = sel && !sel.isCollapsed ? selectionToCopy(sel.toString()) : '';
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => say(T('copié : ' + plural(text.split('\n').length, 'ligne', 'lignes') + ' · ' + text.length.toLocaleString(LOCALE) + ' caractères', 'copied: ' + plural(text.split('\n').length, 'line', 'lines') + ' · ' + text.length.toLocaleString(LOCALE) + ' characters')), () => say(T('copie refusée par le navigateur', 'copy refused by the browser')));
  }, 0);
});
$('q').addEventListener('input', () => { renderList(); scheduleFind(); });
$('bell').onclick = () => { localStorage.setItem('cc.notifSeen', String(Date.now())); select(null); setPane(true); $('main').scrollTop = 0; };
$('mback').onclick = () => { if (selected) select(null); else if (launchMode) closeLauncher(); else if (chatsMode) closeChats(); else if (boardMode) closeBoard(); else if (newMode) closeNew(); else if (bcMode) closeBc(); else setPane(false); };
$('mfind').onclick = () => setPane(true);
$('newbtn').onclick = () => newMode ? closeNew() : openNew();
$('cfgbtn').hidden = REMOTE; $('cfgbtn').onclick = () => { void openCfg(); };
$('cfgcheck').onclick = () => { void cfgSend('check'); }; $('cfgsave').onclick = () => { void cfgSend('save'); }; $('cfgclose').onclick = () => $('cfgdlg').close();
$('bcbtn').onclick = () => bcMode ? closeBc() : openBc();
$('boardbtn').onclick = () => boardMode ? closeBoard() : openBoard();
$('launchbtn').onclick = () => launchMode ? closeLauncher() : openLauncher();
$('chatsbtn').onclick = () => chatsMode ? closeChats() : openChats();
$('favonly').onclick = () => { favOnly = !favOnly; localStorage.setItem('cc.favonly', favOnly ? '1' : '0'); renderList(); };
$('sortbtn').onclick = () => { sortMode = sortMode === 'created' ? 'activity' : 'created'; localStorage.setItem('cc.sort', sortMode); say(sortMode === 'created' ? T('tri par date de création', 'sorted by creation date') : T('tri par dernière activité', 'sorted by last activity')); renderList(); };
// Largeur de la barre latérale : glisser son bord droit, double-clic pour revenir à 360 px ; retenue d'une visite à l'autre.
(() => {
  const app = $('app'), rz = $('resizer');
  const clamp = w => Math.round(Math.max(220, Math.min(w, Math.max(220, innerWidth - 320))));
  const apply = w => { if (w) app.style.setProperty('--sidew', clamp(w) + 'px'); else app.style.removeProperty('--sidew'); };
  apply(+localStorage.getItem('cc.sidew') || 0);
  rz.addEventListener('pointerdown', e => {
    e.preventDefault(); rz.setPointerCapture(e.pointerId); rz.classList.add('drag'); document.body.classList.add('resizing');
    const move = ev => apply(ev.clientX);
    const up = () => {
      rz.removeEventListener('pointermove', move); rz.removeEventListener('pointerup', up); rz.removeEventListener('pointercancel', up);
      rz.classList.remove('drag'); document.body.classList.remove('resizing');
      localStorage.setItem('cc.sidew', String(parseInt(getComputedStyle(app).getPropertyValue('--sidew')) || 0));
    };
    rz.addEventListener('pointermove', move); rz.addEventListener('pointerup', up); rz.addEventListener('pointercancel', up);
  });
  rz.addEventListener('dblclick', () => { apply(0); localStorage.removeItem('cc.sidew'); });
  addEventListener('resize', () => { const w = +localStorage.getItem('cc.sidew'); if (w) apply(w); });
})();
{ const r = routeParse(location.search);                                          // adresse d'arrivée (lien, F5, notification)
  if (r.view) pendingRoute = r;                                                   // un écran se dessine sur l'état (modules, liste) : au 1er tick
  else if (selected && r.sel) setPane(true); }                                    // lien direct : on arrive sur la session
tick(); loadClosed(); loadRuns(); setInterval(() => { if (!ticking) tick(); else if (link.down) drawLink(); }, 2000); setInterval(loadClosed, 30000); runTimer = setInterval(loadRuns, 30000); setInterval(loadAutomations, 30000);
setInterval(() => { for (const m of document.querySelectorAll('.spinm[data-since]')) m.textContent = spinMeta(m); }, 1000);   // chrono « au travail »
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (!ticking) tick(); loadRuns(); loadAutomations(); } });
