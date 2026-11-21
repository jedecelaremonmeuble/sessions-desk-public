// SCHÉMA DU FICHIER DE CONFIGURATION — config.schema.json (à côté de ce fichier), publié pour les éditeurs (`$schema`).
//
// Le serveur ne s'en sert pas pour LIRE la configuration : chaque lecteur (modules.ts, tagger.ts, teams-watcher.ts)
// garde ses propres gardes et ignore une valeur fausse sans éteindre le reste. Le schéma sert à le DIRE : une clé mal
// orthographiée (« remindrs ») ou une valeur hors bornes est ignorée en silence par le lecteur, la page l'affiche.
//
// Vérificateur maison, sans dépendance : le sous-ensemble de JSON Schema 2020-12 que config.schema.json emploie
// (KEYWORDS). Un mot-clé de plus dans le schéma ⇒ le test qui le relit échoue, plutôt qu'une règle ignorée.
import { readFileSync } from 'node:fs';

export type Schema = Record<string, unknown>;
export interface Problem { path: string; message: string }

/** Mots-clés compris. Les autres (description, title, $schema, $id, $defs) ne décrivent rien à vérifier. */
export const KEYWORDS = new Set(['type', 'properties', 'additionalProperties', 'required', 'items', 'enum', 'minimum', 'maximum',
  'exclusiveMinimum', 'minLength', 'maxLength', 'maxItems', 'pattern', 'format', '$ref']);
export const ANNOTATIONS = new Set(['description', 'title', '$schema', '$id', '$defs']);

let cached: Schema | null = null;
export function configSchema(): Schema {
  return cached ??= JSON.parse(readFileSync(new URL('./config.schema.json', import.meta.url), 'utf8')) as Schema;
}

const kind = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const fits = (v: unknown, t: string): boolean => { const k = kind(v); return k === t || (t === 'number' && k === 'integer'); };
const join = (p: string, k: string | number): string => (typeof k === 'number' ? `${p}[${k}]` : p ? `${p}.${k}` : k);
const NAMES: Record<string, string> = { string: 'un texte', number: 'un nombre', integer: 'un entier', boolean: 'true ou false', object: 'un objet { … }', array: 'une liste [ … ]', null: 'null' };

/** Problèmes de `value` au regard de `schema` (le schéma de config.json par défaut). Liste vide : conforme. */
export function validate(value: unknown, schema: Schema = configSchema(), root: Schema = schema, path = ''): Problem[] {
  const out: Problem[] = [];
  const say = (message: string, p = path): void => { out.push({ path: p || '(racine)', message }); };
  let s = schema;
  if (typeof s.$ref === 'string') {
    const m = /^#\/\$defs\/(.+)$/.exec(s.$ref); const target = m ? (root.$defs as Record<string, Schema> | undefined)?.[m[1]!] : undefined;
    if (!target) { say(`schéma : référence inconnue ${s.$ref}`); return out; }
    s = { ...target, ...s }; delete s.$ref;
  }
  if (typeof s.type === 'string' && !fits(value, s.type)) { say(`attendu : ${NAMES[s.type] ?? s.type}, trouvé : ${NAMES[kind(value)] ?? kind(value)}`); return out; }
  if (Array.isArray(s.enum) && !s.enum.some((e) => e === value)) say(`valeur refusée ${JSON.stringify(value)} (admis : ${s.enum.map((e) => JSON.stringify(e)).join(', ')})`);
  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) say(s.minLength === 1 ? 'texte vide' : `${s.minLength} caractères au moins`);
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) say(`${s.maxLength} caractères au plus (${value.length})`);
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(value)) say(`forme refusée (attendu : ${s.pattern})`);
    if (s.format === 'regex') { try { new RegExp(value); } catch (e) { say(`expression régulière invalide (${(e as Error).message})`); } }
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) say(`${s.minimum} au moins (${value})`);
    if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum) say(`plus de ${s.exclusiveMinimum} (${value})`);
    if (typeof s.maximum === 'number' && value > s.maximum) say(`${s.maximum} au plus (${value})`);
  }
  if (Array.isArray(value)) {
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) say(`${s.maxItems} éléments au plus (${value.length})`);
    if (s.items && typeof s.items === 'object') value.forEach((v, i) => out.push(...validate(v, s.items as Schema, root, join(path, i))));
  }
  if (kind(value) === 'object') {
    const o = value as Record<string, unknown>; const props = (s.properties ?? {}) as Record<string, Schema>;
    if (Array.isArray(s.required)) for (const k of s.required as string[]) if (!(k in o)) say(`clé « ${k} » obligatoire`);
    for (const [k, v] of Object.entries(o)) {
      if (props[k]) out.push(...validate(v, props[k], root, join(path, k)));
      else if (s.additionalProperties === false) say('clé inconnue, ignorée', join(path, k));
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') out.push(...validate(v, s.additionalProperties as Schema, root, join(path, k)));
    }
  }
  return out;
}

/** Une ligne par problème, pour la page et la ligne de commande : « modules.teams.remindrs : clé inconnue, ignorée ». */
export const describe = (ps: Problem[]): string[] => ps.map((p) => `${p.path} : ${p.message}`);

/** Mots-clés du schéma que validate() ne comprend pas (doit rester vide : vérifié par les tests). */
export function unknownKeywords(s: unknown, path = '#'): string[] {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (k === 'properties' || k === '$defs') { for (const [n, sub] of Object.entries(v as Record<string, unknown>)) out.push(...unknownKeywords(sub, `${path}/${k}/${n}`)); continue; }
    if (k === 'items' || (k === 'additionalProperties' && typeof v === 'object')) { out.push(...unknownKeywords(v, `${path}/${k}`)); continue; }
    if (!KEYWORDS.has(k) && !ANNOTATIONS.has(k)) out.push(`${path}/${k}`);
  }
  return out;
}
