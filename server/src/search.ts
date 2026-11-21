// RECHERCHE PLEIN TEXTE dans les conversations — portage de -IndexSearch (indexeur), TextSearch (C#) et
// Find-InConversations. Index partagé : ~/.claude/state/search-index (<id>.txt « horodatage TAB rôle TAB texte »,
// <id>.norm en minuscules sans accents, manifest.json). C'est le serveur principal qui le tient : l'indexeur ne
// tourne qu'en rôle « primary ».
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Dashboard } from './state.ts';
import { setPhase } from './stall.ts';
import { ntfsSort } from './state.ts';
import { imatch, leaf, mtimeMs, netTrim, nowMs, parent, readJson, setContent, stripBom } from './util.ts';

/** ConvertTo-SearchNorm */
export function norm(s: string): string { return s.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '').normalize('NFC'); }

/** TextSearch.MatchingLines : triplets à plat (ligne, début, fin) des lignes qui contiennent tous les mots. */
export function matchingLines(text: string, tokens: string[]): number[] {
  const res: number[] = [];
  if (!tokens.length) return res;
  for (const t of tokens) if (text.indexOf(t) < 0) return res;
  let line = 0, lineStart = 0, scanned = 0;
  let pos = text.indexOf(tokens[0]!);
  while (pos >= 0) {
    for (let i = scanned; i < pos; i++) if (text.charCodeAt(i) === 10) { line++; lineStart = i + 1; }
    scanned = pos;
    let le = text.indexOf('\n', pos); if (le < 0) le = text.length;
    let ok = true;
    for (let k = 1; k < tokens.length && ok; k++) { const at = text.indexOf(tokens[k]!, lineStart); ok = at >= 0 && at + tokens[k]!.length <= le; }
    if (ok) res.push(line, lineStart, le);
    if (le >= text.length) break;
    pos = text.indexOf(tokens[0]!, le);
  }
  return res;
}

interface Hit { id: string; norm: string; m: number[]; at: number }

/** Un filtre de tag dans une recherche : « axe:valeur » (« tag:valeur » = n'importe quel axe). */
export const TAG_TOKEN = /^(domaine|outil|fonction|origine|hd|tag):.+$/;
/** Valeur d'un tag telle qu'un filtre l'écrit : sans accents, minuscules, « - » entre les mots (« Tickets & vues » → tickets-vues). */
export const tagSlug = (v: string): string => norm(v).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** Test-TagTokens : la session porte-t-elle chacun des filtres ? */
export function tagsMatch(tags: { axis: string; v: string }[] | null, toks: string[]): boolean {
  if (!toks.length) return true;
  if (!tags) return false;
  const have = new Set<string>();
  for (const t of tags) { const s = tagSlug(t.v); have.add(t.axis + ':' + s); have.add('tag:' + s); }
  return toks.every((k) => have.has(k));
}

export class Search {
  readonly d: Dashboard;
  readonly dir: string;
  #cache = new Map<string, { len: number; text: string }>();
  #paths: Record<string, string> = {};
  #manAt = -1;
  indexing = false;
  #lastRun = 0;

  constructor(d: Dashboard) { this.d = d; this.dir = d.sf('search-index'); }

  /** TextSearch.SearchDir : .norm gardés en mémoire, relus quand leur taille change ; dernière activité d'abord. */
  searchDir(tokens: string[]): Hit[] {
    const hits: Hit[] = [];
    let names: string[]; try { names = ntfsSort(readdirSync(this.dir)); } catch { return hits; }
    for (const n of names) {
      if (!n.toLowerCase().endsWith('.norm')) continue;
      const full = join(this.dir, n);
      let st; try { st = statSync(full); } catch { continue; }
      let c = this.#cache.get(full);
      if (!c || c.len !== st.size) {
        try { c = { len: st.size, text: stripBom(readFileSync(full, 'utf8')) }; } catch { continue; }
        this.#cache.set(full, c);
      }
      const m = matchingLines(c.text, tokens);
      if (m.length) hits.push({ id: n.slice(0, -5), norm: c.text, m, at: st.mtimeMs });
    }
    hits.sort((a, b) => b.at - a.at);
    return hits;
  }
  /** Warm : tout l'index en mémoire au démarrage, sinon la première recherche prend ~20 s. */
  warm(): void { setTimeout(() => { setPhase('recherche'); try { this.searchDir(['\u0001']); } catch { /* idem */ } }, 0); }

  /** Find-InConversations */
  find(query: string): Record<string, unknown> {
    const t0 = performance.now();
    // « domaine:telephonie sms » : les filtres de tags restreignent aux sessions qui portent CHACUN d'eux (valeur exacte),
    // les autres mots sont cherchés dans les conversations comme avant.
    const all = [...new Set(norm(query).split(' ').filter((x) => x.length >= 2))];
    const tagToks = all.filter((x) => TAG_TOKEN.test(x));
    const tokens = all.filter((x) => !TAG_TOKEN.test(x));
    const man = join(this.dir, 'manifest.json');
    const mt = mtimeMs(man);
    if (mt && mt !== this.#manAt) {
      const p: Record<string, string> = {};
      try { for (const [path, v] of Object.entries((readJson(man) ?? {}) as Record<string, { id: string }>)) p[v.id] = path; } catch { /* idem */ }
      this.#paths = p; this.#manAt = mt;
    }
    const paths = this.#paths;
    const res: Record<string, unknown> = { q: query, indexed: Object.keys(paths).length, indexing: this.indexing, hits: [], total: 0, ms: 0 };
    if (tagToks.length) res.tags = tagToks;
    if (!tokens.length) return res;
    let found = this.searchDir(tokens);
    if (tagToks.length) found = found.filter((h) => tagsMatch(this.d.sessionTags(h.id), tagToks));
    res.total = found.reduce((t, h) => t + h.m.length / 3, 0);
    // Tes sessions avant les lancements automatiques (worktrees auto-…, dossiers sous AppData).
    const isAuto = (h: Hit): boolean => !!imatch(leaf(parent(paths[h.id] ?? '')), /-worktrees-auto-|AppData/);
    found = [...found.filter((h) => !isAuto(h)), ...found.filter(isAuto)];
    const hits: Record<string, unknown>[] = [];
    for (const h of found.slice(0, 40)) {
      let ol: string[];
      try { ol = readFileSync(join(this.dir, h.id + '.txt'), 'utf8').replace(/^﻿/, '').split(/\r\n|\n|\r/); if (ol.at(-1) === '') ol.pop(); } catch { continue; }
      const snips: Record<string, unknown>[] = [];
      for (let j = h.m.length - 3; j >= Math.max(0, h.m.length - 9); j -= 3) {
        const i = h.m[j]!; if (i >= ol.length) continue;
        const parts = splitN(ol[i]!, '\t', 3); if (parts.length < 3) continue;
        const text = parts[2]!; const nt = h.norm.slice(h.m[j + 1]!, h.m[j + 2]!).replace(/\r+$/, '');
        const src = nt.length === text.length ? text : nt;
        const pos = Math.max(0, nt.indexOf(tokens[0]!));
        const from = Math.max(0, pos - 110); const len = Math.min(src.length - from, 300);
        snips.push({ at: parts[0], role: parts[1], text: (from > 0 ? '… ' : '') + src.slice(from, from + len) + (from + len < src.length ? ' …' : '') });
      }
      if (!snips.length) continue;
      const meta = this.d.meta(h.id, paths[h.id] ?? null);
      hits.push({ sessionId: h.id, title: meta.title, cwd: meta.cwd, count: h.m.length / 3, last: snips[0]!.at, snippets: snips });
    }
    res.hits = hits;
    res.sessions = found.length; res.ms = Math.round(performance.now() - t0);
    return res;
  }

  /** Start-SearchIndexer : au plus une passe par minute, jamais deux à la fois. */
  maybeIndex(): void {
    if (this.indexing || nowMs() - this.#lastRun < 60000) return;
    this.#lastRun = nowMs(); this.indexing = true;
    this.index().catch(() => undefined).finally(() => { this.indexing = false; });
  }

  /** -IndexSearch : transcripts lus depuis l'octet où l'on s'était arrêté ; passe bornée à 5 min. */
  async index(): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const manFile = join(this.dir, 'manifest.json');
    const man: Record<string, { id: string; offset: number }> = {};
    try { for (const [k, v] of Object.entries((readJson(manFile) ?? {}) as Record<string, { id: string; offset: number }>)) man[k] = { id: v.id, offset: Number(v.offset) || 0 }; } catch { /* idem */ }
    const deadline = nowMs() + 5 * 60000;
    const save = (): void => { setContent(manFile + '.tmp', JSON.stringify(man)); renameSync(manFile + '.tmp', manFile); };
    const files: { path: string; size: number; mtime: number; id: string }[] = [];
    let dirs: string[] = []; try { dirs = readdirSync(this.d.projectsDir); } catch { /* idem */ }
    for (const d of dirs) {
      const dir = join(this.d.projectsDir, d);
      let names: string[]; try { names = readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (!n.toLowerCase().endsWith('.jsonl')) continue;
        try { const st = statSync(join(dir, n)); if (st.isFile()) files.push({ path: join(dir, n), size: st.size, mtime: st.mtimeMs, id: n.slice(0, -6) }); } catch { /* disparu */ }
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    let n = 0;
    for (const f of files) {
      setPhase('index');
      if (nowMs() > deadline) break;
      const e = man[f.path]; let off = e ? e.offset : 0;
      if (f.size === off) continue;
      const txt = join(this.dir, f.id + '.txt'); const nrm = join(this.dir, f.id + '.norm');
      if (f.size < off) off = 0;
      let buf: Buffer; let got = 0;
      try {
        const fd = openSync(f.path, 'r');
        try { buf = Buffer.alloc(f.size - off); while (got < buf.length) { const r = readSync(fd, buf, got, buf.length - got, off + got); if (r <= 0) break; got += r; } } finally { closeSync(fd); }
      } catch { continue; }
      const last = buf.lastIndexOf(10, got - 1);
      if (last < 0) continue;
      const o: string[] = []; const nn: string[] = [];
      for (const l of buf.toString('utf8', 0, last + 1).split('\n')) {
        if (l.length < 20 || l.includes('"isSidechain":true') || l.includes('"isMeta":true')) continue;
        if (!(l.includes('"type":"user"') || l.includes('"type":"assistant"'))) continue;
        try {
          const root = JSON.parse(l) as { type?: unknown; timestamp?: unknown; message?: { content?: unknown } };
          const role = root.type;
          if (role !== 'user' && role !== 'assistant') continue;
          const ts = typeof root.timestamp === 'string' ? root.timestamp : '';
          const c = root.message!.content;
          const parts = typeof c === 'string' ? [c] : (c as { type?: unknown; text?: unknown }[]).filter((b) => b && b.type === 'text').map((b) => b.text as string);
          for (let t of parts) {
            if (!t) continue;
            t = netTrim(t.replace(/\s+/g, ' '));
            if (t.length < 2 || /^(<local-command|<system-reminder|<command-name>|Caveat:|\[Request interrupted)/i.test(t)) continue;
            o.push(`${ts}\t${role}\t${t}`); nn.push(norm(t));
          }
        } catch { /* ligne cassée */ }
      }
      // File.WriteAllLines / AppendAllLines : une ligne = texte + CRLF.
      const lines = (a: string[]): string => a.map((x) => x + '\r\n').join('');
      if (off === 0) { writeFileSync(txt, lines(o), 'utf8'); writeFileSync(nrm, lines(nn), 'utf8'); }
      else if (o.length) { appendFileSync(txt, lines(o), 'utf8'); appendFileSync(nrm, lines(nn), 'utf8'); }
      man[f.path] = { id: f.id, offset: off + last + 1 };
      if (++n % 100 === 0) save();
      if (n % 20 === 0) await new Promise((r) => setImmediate(r));    // ne pas monopoliser la boucle d'événements
    }
    save();
  }
}

/** String.Split(char, count) */
export function splitN(s: string, sep: string, count: number): string[] {
  const out: string[] = []; let rest = s;
  while (out.length < count - 1) { const i = rest.indexOf(sep); if (i < 0) break; out.push(rest.slice(0, i)); rest = rest.slice(i + sep.length); }
  out.push(rest);
  return out;
}
export { netTrim };
