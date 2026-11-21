// Version en service, affichée dans la page. Elle n'est écrite nulle part à la main : « majeur.mineur » de
// server/package.json + le rang du commit dans l'historique — un merge (squashé) dans main = +1.
//  - copie déployée : le déploiement l'inscrit dans DEPLOYED.txt (Deploy-Plan.ps1, Get-CommitVersion) ; relu quand le
//    fichier change, car un remplacement à chaud de la page le réécrit sans redémarrer le serveur ;
//  - checkout de développement (pas de DEPLOYED.txt) : calculée une fois avec git, suffixe « -dev ».
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface AppVersion { version: string | null; commit: string | null }

/** DEPLOYED.txt → version et commit (lignes « commit <sha> … » et « version <v> »), null si ni l'un ni l'autre. */
export function parseDeployed(text: string): AppVersion | null {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const commit = lines.map(l => /^commit ([0-9a-f]{40})\b/.exec(l)).find(Boolean)?.[1] ?? null;
  const version = lines.map(l => /^version (\S+)/.exec(l)).find(Boolean)?.[1] ?? null;
  return commit || version ? { version, commit } : null;
}

/** « majeur.mineur » de package.json + rang du commit. */
export function versionOf(pkgVersion: string | null | undefined, rank: number): string {
  return `${/^(\d+\.\d+)/.exec(pkgVersion ?? '')?.[1] ?? '0.0'}.${rank}`;
}

function fromGit(root: string): AppVersion | null {
  try {
    const revs = execFileSync('git', ['-C', root, 'rev-list', 'HEAD'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n');
    if (!/^[0-9a-f]{40}$/.test(revs[0] ?? '')) return null;
    let pkg: string | null = null;
    try { pkg = (JSON.parse(readFileSync(join(root, 'server', 'package.json'), 'utf8')) as { version?: string }).version ?? null; } catch { /* base 0.0 */ }
    return { version: `${versionOf(pkg, revs.length)}-dev`, commit: revs[0] as string };
  } catch { return null; }
}

/** Lecteur de la version du dossier `root` (racine du dépôt ou de la copie déployée), avec son cache. */
export function versionReader(root: string): () => AppVersion | null {
  const file = join(root, 'DEPLOYED.txt');
  let stamp = '', cached: AppVersion | null = null, git: AppVersion | null | undefined;
  return () => {
    let now: string;
    try { const st = statSync(file); now = `${st.mtimeMs}.${st.size}`; } catch { return git === undefined ? (git = fromGit(root)) : git; }
    if (now !== stamp) { try { cached = parseDeployed(readFileSync(file, 'utf8')); stamp = now; } catch { /* en cours d'écriture : relu à la prochaine lecture */ } }
    return cached;
  };
}
