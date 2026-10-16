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

/**
 * Every declared (key, value) pair from every source, each tagged with where
 * it came from - nothing overwritten.
 *
 * mergeEnvSources is right for deciding what an instance will see, but wrong
 * to hand a safety scan: the merge keeps one value per key, so the scan only
 * ever sees the winner. A committed `.env.example` holding
 * `DATABASE_URL=localhost` therefore used to hide a real production URL in
 * `.env` - the scan found nothing remote and Twin wrote test traffic into the
 * real database, which is the one thing it promises never to do.
 */
export function collectEnvCandidates(sources: readonly EnvSource[]): { key: string; value: string; source: string }[] {
  const out: { key: string; value: string; source: string }[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    for (const [key, value] of Object.entries(source.vars)) {
      if (value === undefined) continue;
      // Two files declaring the same key the same way is one candidate, but
      // the first source to declare it is the one named: scanning is ordered
      // the way the sources are, so that's the most upstream place to fix.
      const dedupeKey = `${key}=${value}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({ key, value, source: source.name });
    }
  }

  return out;
}
