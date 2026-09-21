// The product was renamed PharmaLLM -> PharmaITChat (docs/superpowers/specs/2026-09-20-pharmaitchat-rename-design.md).
// CLAUDE.md forbids editing ~/.hermes/.env, so the app reads the new PHARMAITCHAT_<suffix> env var name
// first and falls back to the legacy PHARMALLM_<suffix> one. This keeps an unedited .env working; the
// owner can rename the keys in his own time. Remove the fallback once every deployment's .env is renamed.

// Reads PHARMAITCHAT_<suffix>, falling back to PHARMALLM_<suffix>. Blank values (after trimming) on
// either name are treated as absent, same as the rest of the app's env handling.
export function readEnvWithFallback(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  const preferred = env[`PHARMAITCHAT_${suffix}`]?.trim();
  if (preferred) return preferred;
  const legacy = env[`PHARMALLM_${suffix}`]?.trim();
  return legacy ? legacy : undefined;
}
