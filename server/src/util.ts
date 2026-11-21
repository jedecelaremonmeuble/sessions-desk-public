// Petits outils partagés, chacun calqué sur l'équivalent PowerShell / .NET du serveur legacy : là où les deux
// mondes diffèrent (Trim, Split-Path, conversions « $x », [int]"0$p"…), c'est le comportement PowerShell qui est gardé.
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { guardedRead, staleStamp, type ReadResult } from './slowfs.ts';

export const nowMs = (): number => Date.now();

const text = (buf: Uint8Array): string => Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('utf8');
const tailLines = (r: ReadResult): string[] => {
  let lines = text(r.buf).split(String.fromCharCode(10));
  if (r.from > 0) lines = lines.slice(1);
  return lines.filter((l) => netTrim(l).length > 0);
};

/** Read-Tail : les N derniers octets d'un fichier, en lignes non vides ; la 1re ligne, tronquée, est sautée.
 *  Jusqu'à 64 Ko, une ouverture qui traîne rend les lignes précédentes (slowfs.ts) ; au-delà, voir readTailSoft. */
export function readTail(path: string, bytes: number): string[] {
  const r = bytes <= 64 * 1024 ? guardedRead('tail', path, bytes, 'stale') : directTail(path, bytes);
  return r ? tailLines(r) : [];
}
/** Lecture bloquante, dans le fil appelant : rien n'est gardé d'un gros fichier, il n'y a donc rien d'autre à rendre. */
function directTail(path: string, bytes: number): ReadResult | null {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try {
    const st = fstatSync(fd); const len = Math.min(st.size, bytes); const buf = new Uint8Array(len);
    let n = 0;
    while (n < len) { const r = readSync(fd, buf, n, len - n, st.size - len + n); if (r <= 0) break; n += r; }
    return { size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, from: st.size - len, buf: buf.subarray(0, n) };
  } catch { return null; } finally { closeSync(fd); }
}
/** Read-Tail d'un gros fichier, sans figer le serveur : les lignes et la taille du fichier AU MOMENT de la lecture
 *  (-1 : absent ou illisible) ; undefined si le disque n'a pas répondu à temps — à redemander au tour suivant. */
export function readTailSoft(path: string, bytes: number): { size: number; lines: string[] } | undefined {
  const r = guardedRead('tail', path, bytes, 'late');
  if (r === undefined) return undefined;
  return r ? { size: r.size, lines: tailLines(r) } : { size: -1, lines: [] };
}
/** Octets d'un fichier depuis `from` jusqu'à sa fin (lecture incrémentale) ; `from` rendu vaut 0 si le fichier a été
 *  réécrit plus court. null : absent ou illisible ; undefined : pas de réponse à temps, à redemander. */
export function readRange(path: string, from: number): { size: number; from: number; buf: Uint8Array } | null | undefined {
  return guardedRead('range', path, from, 'late');
}

/** Date de création d'un transcript : le 1er horodatage de ses 64 premiers Ko (la 1re ligne n'en porte pas toujours),
 *  à défaut la date de création du fichier ; null s'il est illisible, ou si le disque n'a pas répondu à temps (l'appelant
 *  redemande tant qu'il n'a rien). Ne change plus une fois le transcript écrit. */
export function transcriptCreatedAt(path: string): number | null {
  const r = guardedRead('head', path, 64 * 1024, 'late');
  if (!r) return null;
  const m = /"timestamp":"([^"]+)"/.exec(text(r.buf));
  const t = m ? Date.parse(m[1]!) : NaN;
  if (Number.isFinite(t)) return t;
  return r.birthtimeMs > 0 ? Math.trunc(r.birthtimeMs) : null;
}

/** Texte d'un fichier ; null s'il est absent ou illisible. Une ouverture qui traîne rend le texte précédent (slowfs.ts). */
export function readText(path: string): string | null {
  const r = guardedRead('read', path, 0, 'stale');
  return r ? text(r.buf) : null;
}
/** Début d'un fichier (n octets au plus), mêmes règles que readText. */
export function readHead(path: string, bytes: number): string | null {
  const r = guardedRead('head', path, bytes, 'stale');
  return r ? text(r.buf) : null;
}
/** JSON d'un fichier (BOM toléré, comme Get-Content | ConvertFrom-Json) ; undefined s'il est absent ou illisible. */
export function readJson(path: string): unknown {
  const t = readText(path);
  if (t === null) return undefined;
  try { return JSON.parse(stripBom(t)); } catch { return undefined; }
}
export const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** Set-Content -Encoding utf8 : UTF-8 sans BOM (PowerShell 7) et saut de ligne final CRLF. */
export function setContent(path: string, text: string): void { writeFileSync(path, text + '\r\n', 'utf8'); }
/** Set-Content vers un .tmp puis Move-Item -Force. */
export function setContentAtomic(path: string, text: string, tmp = path + '.tmp'): void { setContent(tmp, text); renameSync(tmp, path); }
/** Add-Content -Encoding utf8 d'une ligne JSON. */
export function addContent(path: string, text: string): void { appendFileSync(path, text + '\r\n', 'utf8'); }

/** Date et taille d'un fichier ; null s'il est absent. Tant qu'une lecture de ce fichier a rendu une valeur périmée
 *  (slowfs.ts), ce sont la date et la taille de CETTE valeur : un cache fondé sur elles ne retient pas le périmé. */
export function fileStamp(path: string): { mtimeMs: number; size: number } | null {
  const s = staleStamp(path);
  if (s !== undefined) return s;
  try { const st = statSync(path); return { mtimeMs: st.mtimeMs, size: st.size }; } catch { return null; }
}
export function mtimeMs(path: string): number { return fileStamp(path)?.mtimeMs ?? 0; }
export function fileSize(path: string): number { return fileStamp(path)?.size ?? -1; }
export const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
export const isFile = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };
export const exists = (p: string): boolean => existsSync(p);

// Char.IsWhiteSpace de .NET (String.Trim) : diffère de String.prototype.trim de JS, qui retire aussi U+FEFF.
const NET_WS_CODES = [9, 10, 11, 12, 13, 32, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
const NET_WS_SET = new Set(NET_WS_CODES.map((c) => String.fromCharCode(c)));
const NET_WS = { test: (ch: string): boolean => NET_WS_SET.has(ch) };
export function netTrim(s: string): string {
  let a = 0, b = s.length;
  while (a < b && NET_WS.test(s[a]!)) a++;
  while (b > a && NET_WS.test(s[b - 1]!)) b--;
  return s.slice(a, b);
}
export function netTrimEnd(s: string): string { let b = s.length; while (b > 0 && NET_WS.test(s[b - 1]!)) b--; return s.slice(0, b); }
/** String.Trim(chars). */
export function trimChars(s: string, chars: string): string {
  let a = 0, b = s.length;
  while (a < b && chars.includes(s[a]!)) a++;
  while (b > a && chars.includes(s[b - 1]!)) b--;
  return s.slice(a, b);
}

/** « "$($x)" » de PowerShell : null → "", tableau → éléments joints par une espace, booléen → True/False. */
export function psString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(psString).join(' ');
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'object') return '@{' + Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}=${psString(x)}`).join('; ') + '}';
  return String(v);
}
/** Vérité PowerShell ([bool]$x, -not $x) d'une valeur issue de ConvertFrom-Json. */
export function psTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length === 1 ? psTruthy(v[0]) : v.length > 0;
  if (typeof v === 'string') return v.length > 0;
  if (typeof v === 'number') return v !== 0;
  return Boolean(v);
}
/** @($x) de PowerShell : null → [], tableau → lui-même, autre → [x]. */
export function psArray(v: unknown): unknown[] { return v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]; }

/** [int]::TryParse (Int32, espaces et signe tolérés). */
export function tryParseInt(s: string | null | undefined): number | null {
  if (s === null || s === undefined || !/^\s*[+-]?\d+\s*$/.test(s)) return null;
  const n = Number(s.trim());
  return Number.isSafeInteger(n) && n >= -2147483648 && n <= 2147483647 ? n : null;
}
/** [uint32]::TryParse. */
export function tryParseUInt(s: string | null | undefined): number | null {
  if (s === null || s === undefined || !/^\s*\+?\d+\s*$/.test(s)) return null;
  const n = Number(s.trim());
  return Number.isSafeInteger(n) && n <= 4294967295 ? n : null;
}
/**
 * Conversion PowerShell d'un texte en [int] ([int]"0$p") : décimal, hexadécimal (« 0x10 » = 16, « 0x » = 0),
 * exposant (« 01e3 »), suffixes kb/mb/gb/tb/pb (« 05kb » = 5120), décimales arrondies au pair. Lève sinon (la route
 * répond alors 500, comme le .ps1).
 */
export function psToInt(text: string): number {
  const t = netTrim(text);
  const m = /^(0x[0-9a-f]*|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(kb|mb|gb|tb|pb)?$/i.exec(t);
  if (!m) throw new Error(`Cannot convert value "${text}" to type "System.Int32".`);
  let n = /^0x/i.test(m[1]!) ? parseInt(m[1]!.slice(2) || '0', 16) : Number(m[1]);
  if (m[2]) n *= 1024 ** (['kb', 'mb', 'gb', 'tb', 'pb'].indexOf(m[2].toLowerCase()) + 1);
  const r = Math.round(n); const v = Math.abs(n - Math.trunc(n)) === 0.5 ? (r % 2 === 0 ? r : r - 1) : r;
  if (!Number.isFinite(v) || v > 2147483647 || v < -2147483648) throw new Error(`Cannot convert value "${text}" to type "System.Int32".`);
  return v;
}
/** [int]"0$p" */
export function psIntZero(v: unknown): number { return psToInt('0' + psString(v)); }

/** Split-Path -Parent d'un chemin Windows. */
export function splitPathParent(p: string): string {
  if (/^[A-Za-z]:\\?$/.test(p)) return '';
  const t = p.replace(/\\+$/, '');
  const i = t.lastIndexOf('\\');
  if (i < 0) return '';
  if (i === 2 && /^[A-Za-z]:/.test(t)) return t.slice(0, 3);
  return t.slice(0, i);
}
export const leaf = (p: string): string => basename(p);
export const parent = (p: string): string => dirname(p);

export const GUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/** -match de PowerShell : insensible à la casse. */
export const imatch = (s: string, re: RegExp): RegExpMatchArray | null => s.match(re.flags.includes('i') ? re : new RegExp(re.source, re.flags + 'i'));

/** Comparaison -eq / -ieq de chaînes PowerShell (insensible à la casse, invariante). */
export const ieq = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? '').toUpperCase() === (b ?? '').toUpperCase();

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Verrou asynchrone : une seule tâche à la fois (la « boucle PowerShell »). */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const p = this.#tail.then(fn, fn);
    this.#tail = p.catch(() => undefined);
    return p;
  }
}
