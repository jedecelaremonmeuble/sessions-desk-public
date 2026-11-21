// ÉDITION DE config.json DEPUIS LA PAGE — depuis le poste seulement (jamais par le tailnet : http.ts le refuse avant).
//
// Le texte est enregistré tel que tapé (mise en forme et ordre gardés), après trois contrôles : JSON lisible, conforme
// au schéma (config.schema.json), et AUCUNE clé protégée modifiée. Une clé protégée fait exécuter un programme ou
// élargit qui peut agir sur le poste (options de claude, scripts du lanceur et des automates, commande de recopie,
// dossier et domaines des demandes entrantes, identité Microsoft, autres postes de confiance) : la changer depuis la
// page reviendrait à lancer n'importe quoi depuis un onglet. Elle se change dans le fichier, à la main.
//
// Avant d'écrire : le fichier n'a pas changé depuis son ouverture dans la page (sinon 409, on ne l'écrase pas), et sa
// version courante part en sauvegarde (config.json.bak-page-<date>, les KEEP_BACKUPS plus récentes gardées).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, validate } from './schema.ts';

/** Chemins protégés : leur valeur (présente, absente ou changée) doit rester celle du fichier sur disque. */
export const PROTECTED = [
  'claudeArgs', 'tailscaleExe', 'peers', 'newSession.folders',
  'modules.launcher', 'modules.automations', 'modules.quota.file',
  'modules.teams.export', 'modules.teams.inbound.cwd', 'modules.teams.inbound.domains',
  'modules.teams.tenant', 'modules.teams.clientId', 'modules.teams.scope', 'modules.teams.mailScope',
  'modules.teams.readScope', 'modules.teams.sendScope', 'modules.teams.serverUrl',
] as const;
export const KEEP_BACKUPS = 5;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function at(v: unknown, path: string): unknown {
  let cur = v;
  for (const k of path.split('.')) { if (!isObj(cur) || !Object.hasOwn(cur, k)) return undefined; cur = cur[k]; }
  return cur;
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export const textHash = (t: string): string => createHash('sha1').update(t).digest('hex');
const parse = (t: string): unknown => JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);

/** Clés protégées dont la valeur diffère. Fichier actuel illisible ou absent : comparé à « rien ». */
export function protectedChanges(before: unknown, after: unknown): string[] {
  return PROTECTED.filter((p) => !same(at(before, p), at(after, p)));
}

/** Réglages modifiés, au niveau le plus fin qui reste un objet (une liste se compare en entier). */
export function changedPaths(before: unknown, after: unknown, path = ''): string[] {
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((k) => changedPaths(before[k], after[k], path ? `${path}.${k}` : k));
  }
  return same(before, after) ? [] : [path || '(tout)'];
}

export interface Check {
  /** Enregistrable : JSON lisible, conforme au schéma, aucune clé protégée touchée. */
  ok: boolean;
  /** JSON illisible : le message de l'analyseur. */
  error: string | null;
  problems: string[];
  protectedChanged: string[];
  changed: string[];
}
export function checkConfig(currentText: string | null, proposedText: string): Check {
  let after: unknown;
  try { after = parse(proposedText); } catch (e) { return { ok: false, error: (e as Error).message, problems: [], protectedChanged: [], changed: [] }; }
  if (!isObj(after)) return { ok: false, error: 'un objet { … } est attendu', problems: [], protectedChanged: [], changed: [] };
  let before: unknown = {};
  if (currentText !== null) { try { before = parse(currentText); } catch { before = {}; } }
  const problems = describe(validate(after)), protectedChanged = protectedChanges(before, after);
  return { ok: !problems.length && !protectedChanged.length, error: null, problems, protectedChanged, changed: changedPaths(before, after) };
}

const read = (file: string): string | null => { try { return readFileSync(file, 'utf8'); } catch { return null; } };
/** Ce que la page ouvre : le texte et son empreinte (rendue à l'enregistrement : le fichier n'a pas bougé entre-temps). */
export function openConfig(file: string): { text: string; base: string; exists: boolean } {
  const t = read(file);
  return { text: t ?? '{\n}\n', base: textHash(t ?? ''), exists: t !== null };
}

export type Save = Check & { saved: boolean; conflict: boolean; backup: string | null };
/** Contrôle puis enregistre. `base` : empreinte du texte ouvert par la page. `now` : pour le nom de la sauvegarde. */
export function saveConfig(file: string, base: string, proposedText: string, now = new Date()): Save {
  const current = read(file);
  if (textHash(current ?? '') !== base) return { ...checkConfig(current, proposedText), ok: false, saved: false, conflict: true, backup: null };
  const c = checkConfig(current, proposedText);
  if (!c.ok) return { ...c, saved: false, conflict: false, backup: null };
  let backup: string | null = null;
  if (current !== null) {
    const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    backup = `${file}.bak-page-${stamp}`;
    writeFileSync(backup, current);
    pruneBackups(file);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, proposedText.endsWith('\n') ? proposedText : proposedText + '\n');
  renameSync(tmp, file);
  return { ...c, saved: true, conflict: false, backup };
}

/** Garde les KEEP_BACKUPS sauvegardes de la page les plus récentes (le nom porte la date : l'ordre alphabétique suffit). */
function pruneBackups(file: string): void {
  const dir = dirname(file), prefix = `${basename(file)}.bak-page-`;
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.startsWith(prefix)).sort(); } catch { return; }
  for (const n of names.slice(0, Math.max(0, names.length - KEEP_BACKUPS))) { try { rmSync(join(dir, n)); } catch { /* verrouillée : la suivante */ } }
}
