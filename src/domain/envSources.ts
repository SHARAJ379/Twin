/**
 * Twin's safety preflight scans everything a spawned instance would inherit:
 * `.env` files, the shell's own environment, `twin.config.json`'s "env", and
 * `--env` overrides. Merging them into one map is enough to make the *decision*
 * - but not to explain it. "DATABASE_URL points at a real host" is unhelpful
 * when the user has no idea which of four places set it, and the natural guess
 * (.env) is wrong as often as not.
 *
 * So the merge keeps provenance alongside the value.
 */
export interface EnvSource {
  /** How an error message should name this source, e.g. ".env" or "--env". */
  name: string;
  vars: Readonly<Record<string, string | undefined>>;
}

export interface MergedEnv {
  env: Record<string, string>;
  /** The source whose value won for `key` - i.e. the place to go and fix it. */
  originOf(key: string): string;
}

/** Later sources win, matching the precedence `twin run` documents (flag > config > env > .env). */
export function mergeEnvSources(sources: readonly EnvSource[]): MergedEnv {
  const env: Record<string, string> = {};
  const origins = new Map<string, string>();

  for (const source of sources) {
    for (const [key, value] of Object.entries(source.vars)) {
      if (value === undefined) continue;
      env[key] = value;
      origins.set(key, source.name);
    }
  }

  return { env, originOf: (key) => origins.get(key) ?? "the environment" };
}
