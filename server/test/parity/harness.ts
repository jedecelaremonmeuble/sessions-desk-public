// HARNAIS DE PARITÉ : le même jeu de tests contre le serveur PowerShell (legacy/sessions-dashboard.ps1) et contre le
// serveur Node, sur un PROFIL FACTICE — rien du vrai ~/.claude n'est lu ni écrit.
//
// Les deux serveurs lisent ~/.claude via USERPROFILE et le lanceur via LOCALAPPDATA : ils sont lancés avec ces deux
// variables pointées sur un dossier temporaire, sans aucune modification du .ps1. Les « sessions » de ce profil sont
// des CONSOLES DE TEST (le pilote en --fake-console) dont l'exe est une copie nommée claude.exe : c'est le nom que le
// .ps1 cherche (Get-Process -Name claude) pour dire qu'une session est vivante. Jamais une vraie session.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DRIVER_EXE, HAS_LEGACY, LEGACY_PS1, REPO, TestConsole, type ConsoleOpts, type Mode } from '../helpers.ts';

export type Kind = 'ps' | 'node';
/** Dossier de données du lanceur dans le profil factice. Le serveur historique en lit un en dur : son nom vient de
 *  son propre dossier (legacy/parity-env.json) ; sans lui, n'importe quel nom convient. */
const LAUNCH_DIR = ((): string => { try { return String(JSON.parse(readFileSync(join(REPO, 'legacy', 'parity-env.json'), 'utf8')).launchDir); } catch { return 'orchestrateur'; } })();
export const KINDS: Kind[] = (process.env.SD_PARITY_SERVERS ?? (HAS_LEGACY ? 'ps,node' : 'node')).split(',').map((s) => s.trim()).filter(Boolean) as Kind[];
/** Ports des serveurs de test (port, et port+1 pour le relais) : PS sur BASE, Node sur BASE+2. Jamais 8765-8768. */
export const PORT_BASE = Number(process.env.SD_PARITY_PORT ?? 8831);
export const portOf = (k: Kind): number => (k === 'ps' ? PORT_BASE : PORT_BASE + 2);

const GUIDS = {
  A: 'aaaaaaaa-0000-4000-8000-000000000001', B: 'bbbbbbbb-0000-4000-8000-000000000002', C: 'cccccccc-0000-4000-8000-000000000003',
  D: 'dddddddd-0000-4000-8000-000000000004', E: 'eeeeeeee-0000-4000-8000-000000000005', F: 'ffffffff-0000-4000-8000-000000000006',
  G: '99999999-0000-4000-8000-000000000007', H: '88888888-0000-4000-8000-000000000008', I: '77777777-0000-4000-8000-000000000009',
  J: '66666666-0000-4000-8000-00000000000a', K: '55555555-0000-4000-8000-00000000000b', L: '44444444-0000-4000-8000-00000000000c',
};
/** Identité Tailscale du profil de test (faux tailscale.exe) : propriétaire du poste, nom du poste sur le tailnet. */
export const TS_OWNER = 'proprio@example.com';
export const TS_HOST = 'poste.example.ts.net';
export const TS_ORIGIN = `https://${TS_HOST}`;
export type SessionKey = keyof typeof GUIDS;

export interface Fixture {
  root: string; home: string; claude: string; lad: string; work: string; launchRoot: string; tailscaleExe: string; semiDir: string;
  ids: typeof GUIDS; consoles: Partial<Record<SessionKey, TestConsole>>; pids: Partial<Record<SessionKey, number>>;
  runDirs: Record<string, string>; t0: number;
  cleanup(): void;
}

const jl = (...o: unknown[]): string => o.map((x) => JSON.stringify(x)).join('\n') + '\n';
const slugOf = (p: string): string => p.replace(/[^A-Za-z0-9]/g, '-');
const utcStamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** Écran d'un dialogue à choix (session qui attend) et d'une session au travail. */
export const DIALOG = ' Bash command\n\n   git push --force-with-lease\n\n Do you want to proceed?\n ❯ 1. Oui\n   2. Non';
export const WORKING = '✻ Pondering… (12s · esc to interrupt)';

export async function buildFixture(): Promise<Fixture> {
  const t0 = Date.now();
  // Nom LONG du dossier temporaire : sur le runner CI, TEMP est un nom court 8.3 (C:\Users\RUNNER~1\…). Le .ps1 compose
  // alors des chemins faux ($d.FullName, nom long, coupé à la longueur de $launchRuns, nom court) et la regex des
  // worktrees n'accepte pas « ~ ». Cas d'environnement de test seulement : le vrai LOCALAPPDATA est en nom long.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sd-parity-')));
  const home = join(root, 'home'); const claude = join(home, '.claude'); const lad = join(home, 'AppData', 'Local');
  const work = join(root, 'work', 'proj'); const work2 = join(root, 'work', 'autre');
  for (const d of ['sessions', 'projects', 'state', 'state\\search-index']) mkdirSync(join(claude, d), { recursive: true });
  for (const d of [work, work2, join(root, 'work', '.claude', 'worktrees', 'wt-un'), join(root, 'work', '.claude', 'worktrees', 'wt-deux')]) mkdirSync(d, { recursive: true });
  const ids = GUIDS;
  // Fausses sessions : le pilote copié sous le nom claude.exe (ses dll à côté).
  const bin = join(root, 'bin'); cpSync(join(DRIVER_EXE, '..'), bin, { recursive: true });
  copyFileSync(DRIVER_EXE, join(bin, 'claude.exe'));
  const claudeExe = join(bin, 'claude.exe');
  // Faux tailscale.exe (les deux serveurs lancent `<exe> status --json` au démarrage) : sans lui, aucune identité, donc
  // aucun accès distant à tester. Un vrai exe : Node refuse de lancer un .cmd sans shell. Compilé par le csc de Windows.
  const tsDir = join(root, 'tailscale'); mkdirSync(tsDir);
  const tailscaleExe = join(tsDir, 'tailscale.exe');
  const status = JSON.stringify({ Self: { UserID: 1, DNSName: `${TS_HOST}.` }, User: { 1: { LoginName: TS_OWNER } } });
  writeFileSync(join(tsDir, 'fake.cs'), `class P { static void Main() { System.Console.Write(${JSON.stringify(status)}); } }`);
  execFileSync(join(process.env.WINDIR ?? process.env.SystemRoot ?? '', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    ['/nologo', `/out:${tailscaleExe}`, join(tsDir, 'fake.cs')], { stdio: 'ignore', windowsHide: true });
  const open = (mode: Mode, o: ConsoleOpts = {}): Promise<TestConsole> => TestConsole.open(mode, { exe: claudeExe, ttl: 900, ...o });
  const consoles: Fixture['consoles'] = {};
  [consoles.A, consoles.B, consoles.C, consoles.D, consoles.E, consoles.F, consoles.G] = await Promise.all([
    open('empty'), open('suggestion', { suggestion: 'ouvre la PR et lance la CI' }), open('draft'), open('empty', { text: DIALOG }),
    open('empty'), open('empty', { text: WORKING }), open('empty'),
  ]);
  const pids: Fixture['pids'] = {};
  for (const [k, c] of Object.entries(consoles)) pids[k as SessionKey] = c!.pid;

  // ~/.claude/sessions/<pid>.json
  const sess = (k: SessionKey, status: string, ageMs: number, extra: Record<string, unknown> = {}): void => {
    const pid = pids[k]!;
    writeFileSync(join(claude, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: ids[k], cwd: work, startedAt: t0 - 3600000, version: '2.1.327',
      kind: 'interactive', entrypoint: 'cli', name: `session-${k}`, status, statusUpdatedAt: t0 - ageMs, updatedAt: t0, ...extra }));
  };
  sess('A', 'idle', 120000); sess('B', 'idle', 90000); sess('C', 'idle', 80000); sess('D', 'waiting', 70000, { waitingFor: 'permission' });
  sess('E', 'busy', 60000); sess('F', 'busy', 60000); sess('G', 'idle', 50000, { entrypoint: 'sdk-cli' });
  // Fiches orphelines : process mort, process vivant qui n'est pas claude.
  writeFileSync(join(claude, 'sessions', '4000001.json'), JSON.stringify({ pid: 4000001, sessionId: ids.K, status: 'idle', cwd: work }));
  writeFileSync(join(claude, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: ids.K, status: 'idle', cwd: work }));
  writeFileSync(join(claude, 'sessions', `${pids.A}.ab12.key`), 'pas une fiche');

  // Dépôt git dans le dossier de travail : un commit, un fichier modifié, un supprimé, un nouveau (état git).
  const git = (...a: string[]): void => { execFileSync('git', ['-C', work, ...a], { stdio: 'ignore', windowsHide: true }); };
  git('init', '-q', '-b', 'feat/essai'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'test'); git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(work, 'a.txt'), 'a'); writeFileSync(join(work, 'b.txt'), 'b'); git('add', '.'); git('commit', '-q', '-m', 'premier commit sans accent');
  writeFileSync(join(work, 'a.txt'), 'a2'); rmSync(join(work, 'b.txt')); writeFileSync(join(work, 'c.txt'), 'c');

  // Transcripts : ~/.claude/projects/<dossier aplati>/<id>.jsonl
  const proj = join(claude, 'projects', slugOf(work)); mkdirSync(proj, { recursive: true });
  const cwdLine = (cwd: string): string => JSON.stringify({ parentUuid: null, type: 'user', cwd, message: { role: 'user', content: 'bonjour' }, timestamp: '2026-11-18T08:00:00.000Z' });
  const asst = (o: { text?: string; model?: string; usage?: boolean; extra?: unknown[] }): string => JSON.stringify({ parentUuid: 'p', type: 'assistant', timestamp: '2026-11-18T08:01:00.000Z',
    message: { model: o.model ?? 'claude-opus-5-5', content: [...(o.text ? [{ type: 'text', text: o.text }] : []), ...(o.extra ?? [])],
      ...(o.usage ? { usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 7 } } : {}) } });
  const wt1 = join(root, 'work', '.claude', 'worktrees', 'wt-un'); const wt2 = join(root, 'work', '.claude', 'worktrees', 'wt-deux');
  const sub = join(work, 'sous', 'dossier');
  writeFileSync(join(proj, `${ids.A}.jsonl`),
    cwdLine(sub) + '\n'                                                  // dossier de lancement retrouvé en remontant : work
    + jl({ type: 'ai-title', aiTitle: 'Titre IA de A' }, { type: 'custom-title', customTitle: 'Titre choisi pour A' }, { type: 'pr-link', prNumber: 42, prUrl: 'https://github.com/o/r/pull/42' })
    + asst({ text: `cd ${wt1}`, extra: [{ type: 'tool_use', name: 'Bash', input: { command: `cd ${wt1} && gh workflow run dev-deploy.yml` } }] }) + '\n'
    + asst({ text: `toujours dans ${wt1.replace(/\\/g, '/')}` }) + '\n'
    + asst({ text: `un mot sur ${wt2}` }) + '\n'
    + asst({ text: 'réponse finale de A\nsur deux lignes', model: 'claude-fable-5-2[1m]', usage: true }) + '\n'
    + JSON.stringify({ parentUuid: 'p', type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'erreur' }] } }) + '\n');
  writeFileSync(join(proj, `${ids.B}.jsonl`), cwdLine(work) + '\n' + jl({ type: 'ai-title', aiTitle: 'Titre de B' }) + asst({ text: 'B'.repeat(1000) + ' fin' }) + '\n');
  for (const k of ['C', 'D', 'E', 'F', 'G'] as const) writeFileSync(join(proj, `${ids[k]}.jsonl`), cwdLine(work) + '\n' + jl({ type: 'ai-title', aiTitle: `Titre de ${k}` }) + asst({ text: `dernier mot de ${k}` }) + '\n');
  // Fermées : H (titrée, proposée après redémarrage), I (titrée, autre dossier), J (sans titre), K (trop vieille).
  const proj2 = join(claude, 'projects', slugOf(work2)); mkdirSync(proj2, { recursive: true });
  writeFileSync(join(proj, `${ids.H}.jsonl`), cwdLine(work) + '\n' + jl({ type: 'ai-title', aiTitle: 'Session fermée H' }) + asst({ text: 'H a fini' }) + '\n');
  writeFileSync(join(proj2, `${ids.I}.jsonl`), cwdLine(work2) + '\n' + jl({ type: 'ai-title', aiTitle: 'Session fermée I' }) + asst({ text: 'I a fini' }) + '\n');
  writeFileSync(join(proj, `${ids.J}.jsonl`), cwdLine(work) + '\n' + asst({ text: 'sans titre' }) + '\n');
  writeFileSync(join(proj, `${ids.K}.jsonl`), cwdLine(work) + '\n' + jl({ type: 'ai-title', aiTitle: 'Trop vieille' }) + '\n');
  // L : fermée, sans titre (ni listée ni proposée), lancée dans un dossier dont le nom contient « ; » — réouverture refusée.
  const semiDir = join(root, 'work', 'pi;ege'); mkdirSync(semiDir);
  const proj3 = join(claude, 'projects', slugOf(semiDir)); mkdirSync(proj3, { recursive: true });
  writeFileSync(join(proj3, `${ids.L}.jsonl`), cwdLine(semiDir) + '\n' + asst({ text: 'sans titre' }) + '\n');
  const old = new Date(t0 - 20 * 86400000); utimesSync(join(proj, `${ids.K}.jsonl`), old, old);
  const h1 = new Date(t0 - 3600000); utimesSync(join(proj, `${ids.H}.jsonl`), h1, h1);
  const h2 = new Date(t0 - 7200000); utimesSync(join(proj2, `${ids.I}.jsonl`), h2, h2);

  // history.jsonl : 8 prompts pour A (6 gardés), un très long (400 gardés), un pour H.
  // Sujet (topicHd) : A part de HD-111111 puis passe à HD-222222 et hd-333333 dans des prompts HORS des 6 affichés
  // ⇒ HD-333333 ; C reste sur le HD de son premier message ⇒ rien.
  const hist = Array.from({ length: 8 }, (_, i) => ({ display: i === 0 ? 'prompt 1 de A sur HD-111111' : i === 1 ? 'prompt 2 de A : HD-222222 puis hd-333333' : `prompt ${i + 1} de A`,
    timestamp: t0 - (8 - i) * 1000, sessionId: ids.A, project: work }));
  hist.push({ display: 'L'.repeat(450), timestamp: t0 - 500, sessionId: ids.B, project: work }, { display: 'reprise de H', timestamp: t0 - 400, sessionId: ids.H, project: work },
    { display: 'cadre HD-444444', timestamp: t0 - 600, sessionId: ids.C, project: work }, { display: 'go sur HD-444444', timestamp: t0 - 300, sessionId: ids.C, project: work });
  writeFileSync(join(claude, 'history.jsonl'), jl(...hist));

  resetState({ claude, ids, t0 });

  // Index de recherche : H parle de vaultwarden.
  const idx = join(claude, 'state', 'search-index');
  writeFileSync(join(idx, `${ids.H}.txt`), `2026-11-18T08:00:00Z\tuser\tOù est le coffre Vaultwarden partagé ?\r\n2026-11-18T08:01:00Z\tassistant\tLe coffre vaultwarden est sur le poste.\r\n`);
  writeFileSync(join(idx, `${ids.H}.norm`), 'ou est le coffre vaultwarden partage ?\r\nle coffre vaultwarden est sur le poste.\r\n');
  writeFileSync(join(idx, 'manifest.json'), JSON.stringify({ [join(proj, `${ids.H}.jsonl`)]: { id: ids.H, offset: 10 } }));

  // Tags de l'étiqueteur : A (ouverte) a des tags valides ET des entrées à écarter
  // (axe inconnu, valeur vide, trop longue, non texte) ; H (fermée) un seul tag ; B un fichier illisible ; C un `tags`
  // qui n'est pas un tableau ; D un tableau dont rien ne reste. Les deux serveurs doivent rendre la même chose.
  const tagDir = join(claude, 'state', 'session-tags'); mkdirSync(tagDir, { recursive: true });
  // Vocabulaire des tags, publié dans le profil factice comme le ferait l'étiqueteur.
  writeFileSync(join(tagDir, '_vocab.json'), JSON.stringify({ domaines: ['Téléphonie', 'Compta', 'Tickets'], outils: ['infra', 'mcp', 'page'] }));
  writeFileSync(join(tagDir, `${ids.A}.json`), JSON.stringify({ sessionId: ids.A, tags: [
    { axis: 'origine', v: 'interactive', src: 'entrypoint' }, { axis: 'domaine', v: 'Téléphonie', src: 'hd' }, { axis: 'outil', v: 'infra' },
    { axis: 'inconnu', v: 'x', src: 'y' }, { axis: 'outil', v: '' }, { axis: 'fonction', v: 'f'.repeat(61) }, { axis: 'hd', v: 12 }, 'texte', null,
    { axis: 'fonction', v: 'power-dial', src: 3 }, { axis: 'hd', v: 'HD-555555', src: 'prompt' } ] }));
  writeFileSync(join(tagDir, `${ids.H}.json`), JSON.stringify({ tags: [{ axis: 'domaine', v: 'Compta', src: 'fichiers' }] }));
  writeFileSync(join(tagDir, `${ids.B}.json`), '{ pas du json');
  writeFileSync(join(tagDir, `${ids.C}.json`), JSON.stringify({ tags: { axis: 'outil', v: 'infra' } }));
  writeFileSync(join(tagDir, `${ids.D}.json`), JSON.stringify({ tags: [{ axis: 'x', v: 'y' }] }));

  // Lanceur : runs\HD-<n>\<aaaammjj-hhmmss>[-phase]\, state.json, stages.json, claude-usage.json, heartbeat.
  const launchRoot = join(lad, LAUNCH_DIR); const runs = join(launchRoot, 'runs');
  const runDirs: Record<string, string> = {
    diag: join(runs, 'HD-111', utcStamp(t0 - 2 * 3600000)), dev: join(runs, 'HD-111', utcStamp(t0 - 3600000) + '-dev'),
    other: join(runs, 'HD-222', utcStamp(t0 - 1800000)), old: join(runs, 'HD-222', utcStamp(t0 - 100 * 3600000)),
  };
  for (const d of Object.values(runDirs)) mkdirSync(d, { recursive: true });
  writeFileSync(join(runDirs.diag!, 'result.md'), '# Diagnostic de 111\n\ntexte');
  writeFileSync(join(runDirs.diag!, 'note.html'), '<script>alert(1)</script>');
  writeFileSync(join(runDirs.diag!, 'review.md'), 'relecture');
  writeFileSync(join(runDirs.diag!, 'Capture.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(runDirs.diag!, 'settings.json'), '{}');
  writeFileSync(join(runDirs.diag!, 'mcp.json'), '{}');
  writeFileSync(join(runDirs.diag!, 'secret.exe'), 'x');
  writeFileSync(join(runDirs.dev!, 'pr.md'), '## **fix(x): le titre de la PR de 111**\n');
  writeFileSync(join(runDirs.other!, 'transcript.jsonl'), '{"type":"system","session_id":"12345678-1234-1234-1234-123456789abc"}\n');
  writeFileSync(join(launchRoot, 'state.json'), JSON.stringify({
    requests: {
      111: { title: null, attempts: [{ runDir: runDirs.diag, outcome: 'failed', detail: 'écriture refusée', minutes: 4.5, costUsd: 1.005, turns: 29, sessionId: '3c7e46be-17d0-48d6-b2c9-e5c3b238b0ef', mcpServers: [{ runDir: 'ignoré' }] }],
        dev: { runDir: runDirs.dev, sessionOutcome: 'success', sessionMinutes: 12, costUsd: 2.5 } },
      222: { title: 'Titre de 222', attempts: [{ runDir: runDirs.other, status: 'running' }] },
    },
    lastWait: { message: 'disque C: presque plein', at: 1794588312.08041 }, lastPassError: { message: 'TimeoutExpired', at: 1794588000.5 },
    triage: 'shadow', devMode: 'pr', recetteMode: 'on', reworkMode: null,
  }));
  const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  writeFileSync(join(launchRoot, 'stages.json'), JSON.stringify({ sent: {
    111: JSON.stringify({ stage: 'dev-failed', since: '2026-11-18T09:00:00Z', detail: 'push refusé par la branche protégée', prNumber: null }),
    222: JSON.stringify({ stage: 'pr-awaiting-approval', waitingOn: 'owner', since: '2026-11-18T10:30:00+01:00', prNumber: 5, prUrl: 'https://github.com/o/r/pull/5' }),
    333: JSON.stringify({ stage: 'in-production', waitingOn: 'personne', since: '2026-11-17T10:00:00Z' }),
    // « t'attend » (waitingOn = actor) : 444 passé il y a 10 min ⇒ alerte ; 555 écarté (rien à décider) et 666 passé
    // il y a 3 h ⇒ rien.
    444: JSON.stringify({ stage: 'diagnosis-held', waitingOn: 'actor', since: iso(t0 - 10 * 60000), detail: 'diagnostic posé,\n  aucun correctif lancé' }),
    555: JSON.stringify({ stage: 'diagnosis-skipped', waitingOn: 'actor', since: iso(t0 - 5 * 60000), detail: 'jni a déjà écrit' }),
    666: JSON.stringify({ stage: 'dev-abandoned', waitingOn: 'actor', since: iso(t0 - 3 * 3600000), detail: 'déjà corrigé' }),
  } }));
  writeFileSync(join(launchRoot, 'claude-usage.json'), JSON.stringify({
    'uuid-1': { alias: 'a@exemple.fr', plan: 'max', weeklyPct: 92, weeklyResetsAt: iso(t0 + 86400000), fiveHourPct: 10, fiveHourResetsAt: null,
      weeklyProjectedPct: 120, weeklyFullAt: iso(t0 + 3600000), measuredAt: iso(t0 - 60000), status: 'ok',
      limitsJson: JSON.stringify([{ kind: 'weekly_scoped', percent: 43, scope: { model: { display_name: 'Fable' } }, resets_at: iso(t0 + 86400000), is_active: true, severity: 'warn' },
        { kind: 'weekly_scoped', percent: 95, scope: { model: { display_name: 'Opus' } }, resets_at: iso(t0 + 86400000), is_active: false, severity: 'critical' }]) },
    'uuid-2': { alias: 'b@exemple.fr', plan: 'pro', weeklyPct: null, weeklyResetsAt: null, limitsJson: 'None', measuredAt: '2026-11-16T17:20:07Z', status: 'error:network' },
  }));
  // Muet depuis 50 min (> 45) : « arrêté » même si un VRAI run du lanceur tourne sur le poste (les deux serveurs lisent
  // les process claude.exe réels pour savoir si un run le tient occupé).
  writeFileSync(join(launchRoot, 'heartbeat.stamp'), iso(t0 - 50 * 60000));
  // Modules optionnels (server/src/modules.ts) : le .ps1 les a tous, en dur ; Node ne les a que par ce fichier.
  // claudeArgs : le défaut du .ps1 (son paramètre -ClaudeArgs), que Node ne tient plus que de ce fichier.
  writeFileSync(join(root, 'sessions-desk-config.json'), JSON.stringify({ claudeArgs: '--dangerously-skip-permissions', modules: { launcher: { root: launchRoot }, teams: { enabled: true },
    tickets: { pattern: 'HD-\\d{6}' }, quota: { file: `%LOCALAPPDATA%\\${LAUNCH_DIR}\\claude-usage.json` } } }));

  return { root, home, claude, lad, work, launchRoot, tailscaleExe, semiDir, ids, consoles, pids, runDirs, t0,
    cleanup(): void { for (const c of Object.values(consoles)) c?.close(); try { rmSync(root, { recursive: true, force: true }); } catch { /* fichier ouvert */ } } };
}

/** État de la page remis à l'identique (favoris, masquées, vu, PR, notifications, relances, redémarrage simulé) et
 *  fichiers propres à chaque serveur de test retirés : chaque bloc de tests part du même profil. */
export function resetState(fx: { claude: string; ids: typeof GUIDS; t0: number }): void {
  const { claude, ids, t0 } = fx;
  const st = (n: string, s: string): void => writeFileSync(join(claude, 'state', n), s);
  for (const f of readdirSync(join(claude, 'state'))) if (/-88\d\d\.(json|jsonl|log)$/.test(f)) rmSync(join(claude, 'state', f), { force: true });
  st('sessions-dashboard-favs.json', JSON.stringify([ids.A, ids.H]));
  st('sessions-dashboard-hidden.json', JSON.stringify([ids.I]));
  // Correction à la main des tags : A perd « outil:infra » et gagne une fonctionnalité ; C (fichier automatique
  // invalide) n'a que son ajout ; entrées écartées : axe non modifiable, identifiant invalide.
  st('sessions-dashboard-tags-manual.json', JSON.stringify({
    [ids.A]: { add: [{ axis: 'fonction', v: 'coffre-fort' }, { axis: 'hd', v: 'HD-1' }], remove: [{ axis: 'outil', v: 'infra' }] },
    [ids.C]: { add: [{ axis: 'domaine', v: 'Compta' }] }, 'pas-un-id': { add: [{ axis: 'outil', v: 'x' }] } }));
  st('sessions-dashboard-seen.json', JSON.stringify({ [ids.A]: t0 - 600000, [ids.B]: t0 }));
  st('sessions-dashboard-pr.json', JSON.stringify({ 'https://github.com/o/r/pull/42': { state: 'MERGED', draft: false, checks: 'ok' } }));
  st('sessions-dashboard-notifs.jsonl', jl({ at: t0 - 5000, kind: 'waiting', sessionId: ids.D, title: 'D attend une réponse', text: 'git push' }, { at: t0 - 4000, kind: 'done', sessionId: ids.A, title: 'A a terminé (4 min)', text: 'fini' }));
  st('restart-idle-sessions.jsonl', jl({ at: t0 - 86400000, pid: 1, name: 'x', sessionId: ids.H, code: 0, result: 'relancée' }));
  // Redémarrage de Windows simulé pour chaque serveur de test : H vue vivante sous un autre démarrage.
  for (const k of KINDS) st(`sessions-dashboard-open-${portOf(k)}.json`, JSON.stringify({ boot: 1000, seen: { [ids.H]: t0 - 60000 } }));

}

/** pwsh lancés par wt (commande encodée) qui citent ce dossier : onglets ouverts par erreur. Fermés ; leurs pid rendus. */
export function killTabsOn(root: string): number[] {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" | Where-Object { $_.CommandLine -match '-EncodedCommand (\\S+)' } | ForEach-Object {
    $c = try { [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1])) } catch { '' }
    if ($c.Contains('${root.replace(/'/g, "''")}')) { $_.ProcessId; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }`;
  try {
    return execFileSync('pwsh', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true }).split(/\s+/).filter(Boolean).map(Number);
  } catch { return []; }
}

// ───────────── serveurs ─────────────
export interface Srv { kind: Kind; port: number; base: string; proc: ChildProcess; stderr: string; stop(): Promise<void> }

export async function startServer(kind: Kind, fx: Fixture): Promise<Srv> {
  const port = portOf(kind);
  const env = { ...process.env, USERPROFILE: fx.home, LOCALAPPDATA: fx.lad };
  const proc = kind === 'ps'
    ? spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', LEGACY_PS1, '-Port', String(port), '-NoBackground', '-NotifyAfterSeconds', '0', '-NotifyDoneAfterMinutes', '0', '-TailscaleExe', fx.tailscaleExe],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.execPath, [join(REPO, 'server', 'src', 'main.ts'), '--port', String(port), '--no-background', '--allow-write', '--notify-after', '0', '--notify-done-after', '0', '--driver', DRIVER_EXE, '--config', join(fx.root, 'sessions-desk-config.json'), '--tailscale', fx.tailscaleExe],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const s: Srv = { kind, port, base: `http://localhost:${port}`, proc, stderr: '',
    async stop() { if (proc.exitCode === null) { await call(s, '/api/stop').catch(() => undefined); for (let i = 0; i < 50 && proc.exitCode === null; i++) await sleep(100); } if (proc.exitCode === null) proc.kill(); } };
  proc.stderr!.on('data', (b: Buffer) => { s.stderr += b.toString('utf8'); });
  proc.stdout!.resume();
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error(`${kind} : arrêté au démarrage (code ${proc.exitCode}) : ${s.stderr}`);
    const r = await call(s, '/api/ping').catch(() => null);
    if (r?.code === 200) return s;
    await sleep(250);
  }
  throw new Error(`${kind} : pas de réponse au ping en 30 s : ${s.stderr}`);
}

// ───────────── HTTP ─────────────
export interface Res { code: number; body: string; headers: Record<string, string | string[] | undefined>; json<T = any>(): T }
export interface CallOpts { method?: string; origin?: string | null; body?: string | Buffer; headers?: Record<string, string>; host?: string; port?: number; addr?: string; timeoutMs?: number }

/** Requête brute (node:http) : en-têtes Host et Origin maîtrisés, pas de suivi de redirection. */
export function call(s: Srv, path: string, o: CallOpts = {}): Promise<Res> {
  return new Promise((ok, ko) => {
    const headers: Record<string, string> = { host: o.host ?? `localhost:${s.port}`, ...(o.headers ?? {}) };
    if (o.origin) headers.origin = o.origin;
    if (o.body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json; charset=utf-8';
    if (o.body !== undefined) headers['content-length'] = String(Buffer.byteLength(o.body));
    const rq = request({ host: o.addr ?? '127.0.0.1', port: o.port ?? s.port, path, method: o.method ?? 'GET', headers, timeout: o.timeoutMs ?? 60000 }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => { const body = Buffer.concat(parts).toString('utf8').replace(/^﻿/, ''); ok({ code: res.statusCode ?? 0, body, headers: res.headers, json: () => JSON.parse(body) }); });
    });
    rq.on('timeout', () => rq.destroy(new Error('délai dépassé')));
    rq.on('error', ko);
    if (o.body !== undefined) rq.write(o.body);
    rq.end();
  });
}
export const post = (s: Srv, path: string, body?: unknown, o: CallOpts = {}): Promise<Res> =>
  call(s, path, { method: 'POST', origin: s.base, body: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body), ...o });

/** Attend qu'une condition sur l'état soit vraie (calculé chaque seconde par les deux serveurs). */
export async function waitState<T>(s: Srv, pick: (st: any) => T | undefined | null | false, ms = 20000): Promise<T> {
  const until = Date.now() + ms; let last: any;
  while (Date.now() < until) {
    const r = await call(s, '/api/state'); if (r.code === 200) { last = r.json(); const v = pick(last); if (v) return v; }
    await sleep(300);
  }
  throw new Error(`condition jamais vraie en ${ms} ms ; dernier état : ${JSON.stringify(last)?.slice(0, 400)}`);
}
export { sleep };
