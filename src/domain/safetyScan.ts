// The single most important safety rule (§9.1, invariant I8): vibe-coded
// apps very often have a live Supabase/Neon/Mongo URL sitting in .env.
// Twin must refuse to run test traffic against it by default.

// Anchored to a database/service keyword, not just a "_URL"/"_URI" suffix:
// CI runners (GitHub Actions among them) set plenty of ambient *_URL vars of
// their own (GITHUB_API_URL, GITHUB_SERVER_URL, ...) that have nothing to do
// with a database and would otherwise false-positive on every CI run.
const SUSPICIOUS_KEY_PATTERN =
  /(^|_)(DATABASE|DB|MONGO|MONGODB|REDIS|SUPABASE|POSTGRES|POSTGRESQL|MYSQL|SQLITE|PLANETSCALE|NEON|COCKROACH|COCKROACHDB|DYNAMODB|FIRESTORE|DSN|CONNECTION_STRING)(_|$)/i;

const THIRD_PARTY_KEY_PATTERN = /^(STRIPE|SENDGRID|TWILIO|OPENAI|ANTHROPIC|MAILGUN|POSTMARK|SMTP|AWS_SES)/i;

export interface RemoteResourceRef {
  key: string;
  host: string;
}

function isLocalHost(hostname: string): boolean {
  // URL.hostname keeps brackets around an IPv6 literal ("[::1]"), unlike every other host form.
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    normalized.endsWith(".local")
  );
}

/**
 * Env vars that look like a connection string pointing somewhere non-local.
 * Deliberately conservative: a value that doesn't parse as a URL (a bare
 * password, a unix socket path, garbage) is skipped rather than guessed at -
 * false negatives here are far cheaper than refusing to run on a false positive.
 */
export function scanForRemoteResources(env: Readonly<Record<string, string>>): RemoteResourceRef[] {
  const found: RemoteResourceRef[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!SUSPICIOUS_KEY_PATTERN.test(key)) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (!isLocalHost(url.hostname)) found.push({ key, host: url.hostname });
  }
  return found;
}

/** Third-party keys (§9.2) warrant a warning, not a refusal - a scenario run may trigger real Stripe/email/SMS/LLM calls. */
export function scanForThirdPartyKeys(env: Readonly<Record<string, string>>): string[] {
  return Object.keys(env).filter((key) => THIRD_PARTY_KEY_PATTERN.test(key));
}
