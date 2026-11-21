// APPROBATION DES DOSSIERS — Claude Code demande, au premier lancement interactif dans un dossier, « Do you trust the
// files in this folder? », même avec --dangerously-skip-permissions. Tant qu'on n'a pas répondu, la session n'écrit
// ni transcript ni fichier de suivi : lancée depuis la page, elle resterait bloquée EN SILENCE dans un onglet. Le
// serveur lit donc l'approbation (jamais il ne l'écrit) pour prévenir et refuser au lieu de lancer dans le vide.
//
// Source : `projects[<chemin>].hasTrustDialogAccepted` de la configuration globale de Claude Code (`.claude.json` du
// dossier de configuration quand CLAUDE_CONFIG_DIR le déplace, sinon celui du dossier personnel — comme usage.ts).
// Les clés s'y trouvent sous les deux formes `C:\a\b` et `C:/a/b`, casse sans importance.
//
// ⚠ Pas d'héritage : l'approbation se lit sur le dossier EXACT où `claude` démarre. Observé : un dossier parent
// approuvé n'évite pas la question dans un sous-dossier qui est lui-même un dépôt git. Faute de règle documentée, on
// ne déduit rien d'un parent — un worktree neuf n'est donc jamais approuvé d'avance (actions.ts : avertir, pas refuser).

import { dirname, join } from 'node:path';
import { fileStamp, readJson } from './util.ts';

/** Forme de comparaison : barres obliques, sans barre finale, en minuscules (`C:\A\` → `c:/a`, `C:\` → `c:`). */
export function trustKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Dossiers approuvés (formes de comparaison) d'un contenu de `.claude.json` ; tout le reste est ignoré. */
export function trustedRoots(raw: unknown): string[] {
  const projects = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>).projects : undefined;
  if (projects === null || typeof projects !== 'object' || Array.isArray(projects)) return [];
  const out = new Set<string>();
  for (const [k, v] of Object.entries(projects as Record<string, unknown>)) {
    if (!k || v === null || typeof v !== 'object' || (v as Record<string, unknown>).hasTrustDialogAccepted !== true) continue;
    const key = trustKey(k); if (key) out.add(key);
  }
  return [...out];
}

/** Le dossier EXACT est-il approuvé ? Un parent approuvé ne compte pas (voir en tête). */
export function isTrusted(path: string, roots: readonly string[]): boolean {
  const p = trustKey(path);
  return p !== '' && roots.includes(p);
}

/** Emplacement de `.claude.json` pour un dossier de configuration `claudeDir` (~/.claude) : dedans s'il y est, sinon à
 *  côté. */
export function claudeJsonPath(claudeDir: string, exists: (f: string) => boolean): string {
  const inDir = join(claudeDir, '.claude.json');
  return exists(inDir) ? inDir : join(dirname(claudeDir), '.claude.json');
}

/** Refus d'un lancement dans un dossier non approuvé : ce qui se passerait, et quoi faire. */
export const UNTRUSTED_REFUSED = (dir: string): [string, string] => [
  `dossier non approuvé dans Claude Code : ${dir} — la session resterait bloquée, sans rien dire, sur la question « Do you trust the files in this folder? ». Lancez une fois \`claude\` dans ce dossier et acceptez l'approbation, ou déclarez un dossier approuvé.`,
  `folder not trusted in Claude Code: ${dir} — the session would silently wait on the "Do you trust the files in this folder?" question. Run \`claude\` once in this folder and accept, or declare a trusted folder.`,
];

/** Lecture tenue à jour (chemin + date + taille du fichier). Claude Code réécrit souvent ce fichier : une lecture qui
 *  tombe pendant l'écriture (JSON incomplet) garde le dernier état lu. `null` : jamais lu — statut INCONNU, que
 *  l'appelant ne doit pas traiter comme « non approuvé » (on ne bloque pas un lancement sur notre propre incapacité à
 *  lire). */
export class TrustReader {
  #stamp = ''; #roots: string[] | null = null;
  /** Chemin du fichier, réévalué à chaque lecture (il peut apparaître ou changer de place). */
  readonly file: () => string;
  constructor(file: () => string) { this.file = file; }
  roots(): string[] | null {
    const f = this.file(); let stamp = '';
    const s = fileStamp(f); if (!s) return this.#roots;
    stamp = `${f}:${s.mtimeMs}:${s.size}`;
    if (stamp !== this.#stamp) {
      const raw = readJson(f);
      if (raw !== undefined) { this.#roots = trustedRoots(raw); this.#stamp = stamp; }
    }
    return this.#roots;
  }
  /** true / false ; null si le fichier n'a jamais pu être lu. */
  trusted(path: string): boolean | null {
    const r = this.roots();
    return r === null ? null : isTrusted(path, r);
  }
}
