// Quota des comptes Claude (Get-ClaudeUsage) et conversions de dates du lanceur (ConvertTo-LaunchMs).
import type { Config } from './config.ts';
import { mtimeMs, psString, readJson, readText, stripBom } from './util.ts';
import { dirname, join } from 'node:path';

/**
 * ConvertTo-LaunchMs. Côté PowerShell, ConvertFrom-Json a déjà converti les chaînes ISO en DateTime ; ici elles
 * arrivent en texte : Date.parse les lit de la même façon (Z ou décalage ⇒ instant exact, sans décalage ⇒ heure
 * locale, comme un DateTime « Unspecified » passé par ToUniversalTime). Nombre ou texte illisible ⇒ 0.
 */
export function launchMs(v: unknown): number {
  if (typeof v !== 'string') return 0;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) ? t : 0;
}
const msOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || psString(v) === '') return null;
  const x = launchMs(v);
  return x ? x : null;
};

/** Arrondi .NET par défaut (Math.Round, [int]/[long] d'un double) : au pair le plus proche. */
export function roundHalfEven(x: number, digits = 0): number {
  const f = 10 ** digits; const y = x * f;
  const r = Math.round(y);
  const half = Math.abs(y - Math.trunc(y)) === 0.5;
  return (half ? (r % 2 === 0 ? r : r - 1) : r) / f;
}

let cache: { stamp: number; value: unknown[] } = { stamp: -1, value: [] };

/** Get-ClaudeUsage : relevé d'un collecteur externe (module « quota »), relu seulement quand le fichier change. */
export function readClaudeUsage(cfg: Config): unknown[] {
  const f = usageFile(cfg);
  if (!f) return [];
  const stamp = mtimeMs(f);
  if (stamp === cache.stamp) return cache.value;
  let value: unknown[] = [];
  try {
    const j = JSON.parse(stripBom(readText(f) ?? '')) as Record<string, Record<string, unknown>>;
    value = Object.entries(j).map(([uuid, a]) => {
      let limits: unknown[] = [];
      try {
        if (a.limitsJson) {
          const parsed = JSON.parse(String(a.limitsJson)) as unknown;
          limits = (Array.isArray(parsed) ? parsed : [parsed]).map((x) => {
            const l = (x ?? {}) as Record<string, unknown>;
            const scope = l.scope as { model?: { display_name?: unknown } } | undefined;
            return { kind: psString(l.kind), pct: l.percent ?? null, model: scope?.model?.display_name ?? null, resetsAt: msOrNull(l.resets_at), active: Boolean(l.is_active), severity: psString(l.severity) };
          });
        }
      } catch { limits = []; }
      return {
        uuid, alias: a.alias ?? null, plan: a.plan ?? null, status: psString(a.status),
        weeklyPct: a.weeklyPct ?? null, weeklyResetsAt: msOrNull(a.weeklyResetsAt), weeklyProjectedPct: a.weeklyProjectedPct ?? null, weeklyFullAt: msOrNull(a.weeklyFullAt),
        fiveHourPct: a.fiveHourPct ?? null, fiveHourResetsAt: msOrNull(a.fiveHourResetsAt), measuredAt: msOrNull(a.measuredAt), limits,
      };
    });
  } catch { value = []; }
  cache = { stamp, value };
  return value;
}
/**
 * Compte Claude CONNECTÉ : `oauthAccount.accountUuid` de la configuration globale de Claude Code — `.claude.json` du
 * dossier de configuration quand CLAUDE_CONFIG_DIR le déplace, sinon celui du dossier personnel (à côté de ~/.claude).
 * Plusieurs comptes partagent le même profil (bascule par /login) : c'est celui-là que consomment les sessions.
 * Relu seulement quand le fichier change ; null si illisible ou déconnecté.
 */
let acctCache: { file: string; stamp: number; value: string | null } = { file: '', stamp: -1, value: null };
export function activeAccountUuid(cfg: Config): string | null {
  const inDir = join(cfg.claude, '.claude.json');
  const f = mtimeMs(inDir) ? inDir : join(dirname(cfg.claude), '.claude.json');
  const stamp = mtimeMs(f);
  if (f === acctCache.file && stamp === acctCache.stamp) return acctCache.value;
  let value: string | null = null;
  try { const j = JSON.parse(stripBom(readText(f) ?? '')) as { oauthAccount?: { accountUuid?: unknown } }; value = psString(j.oauthAccount?.accountUuid) || null; } catch { /* illisible : inconnu */ }
  acctCache = { file: f, stamp, value };
  return value;
}
/** Marque `active` le relevé du compte connecté (pure). Compte connecté inconnu ⇒ aucun n'est marqué. */
export const markActiveAccount = (quota: unknown[], uuid: string | null): unknown[] =>
  quota.map((q) => ({ ...(q as Record<string, unknown>), active: !!uuid && (q as { uuid?: unknown }).uuid === uuid }));

/** Fichier du relevé : celui du module « quota », '' s'il est éteint. */
export const usageFile = (cfg: Config): string => cfg.modules.quota?.file ?? '';
export const readUsageRaw = (cfg: Config): unknown => { const f = usageFile(cfg); return f ? readJson(f) : undefined; };

/**
 * Proposition de prompt FORCÉE malgré le quota ? Claude Code (2.1.329) cesse d'en générer dès que le quota n'est plus
 * « allowed » (alerte) et après 8 tours sans personne, SAUF si `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` vaut vrai — dans
 * l'environnement ou dans le bloc `env` de ~/.claude/settings.json (relu quand il change). La page s'en sert pour dire
 * si le mode dégradé coupe les propositions. Lue au démarrage de chaque session : une session plus ancienne que le
 * réglage n'en profite pas (`since` = date du fichier, approximation).
 */
let sugCache: { stamp: number; value: { forced: boolean; since: number | null } } = { stamp: -1, value: { forced: false, since: null } };
const truthy = (v: unknown): boolean => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
export function promptSuggestionSetting(cfg: Config, env: NodeJS.ProcessEnv = process.env): { forced: boolean; since: number | null } {
  if (truthy(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION)) return { forced: true, since: null };
  const f = join(cfg.claude, 'settings.json'); const stamp = mtimeMs(f);
  if (stamp === sugCache.stamp) return sugCache.value;
  let forced = false;
  try { const j = JSON.parse(stripBom(readText(f) ?? '')) as { env?: Record<string, unknown> }; forced = truthy(j.env?.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION); } catch { /* illisible : non forcé */ }
  sugCache = { stamp, value: { forced, since: forced && stamp ? Math.trunc(stamp) : null } };
  return sugCache.value;
}
