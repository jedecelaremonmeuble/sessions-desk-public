// Vérifie un fichier de configuration avec config.schema.json : `npm run check-config [-- <fichier>]`.
// Sans argument : --config absent ⇒ SD_CONFIG, puis ~/.claude/sessions-desk/config.json (comme le serveur).
// Code de sortie : 0 conforme, 1 écarts au schéma, 2 fichier absent ou JSON invalide.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, validate } from '../src/schema.ts';

const file = resolve(process.argv[2] ?? process.env.SD_CONFIG ?? join(process.env.USERPROFILE ?? homedir(), '.claude', 'sessions-desk', 'config.json'));
if (!existsSync(file)) { console.error(`${file} : absent`); process.exit(2); }
let raw: unknown;
try { const t = readFileSync(file, 'utf8'); raw = JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t); } catch (e) { console.error(`${file} : JSON invalide (${(e as Error).message})`); process.exit(2); }
const lines = describe(validate(raw));
if (!lines.length) { console.log(`${file} : conforme`); process.exit(0); }
console.log(`${file} : ${lines.length} écart(s) au schéma`);
for (const l of lines) console.log(`  ${l}`);
process.exit(1);
