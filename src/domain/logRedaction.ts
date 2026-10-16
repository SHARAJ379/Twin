// Reports are redacted (redaction.ts), but an instance's own stdout/stderr was
// not - and Twin both writes it to `.twin/runs/<id>/logs/<instance>.log` and
// prints the tail inline when an instance fails to boot. An app that echoes
// its connection string on startup therefore leaked it straight into a public
// CI log. This is the one place that decides what a log line may still say.

const MASK = "<redacted>";

/** Env vars whose *value* is a secret in its own right, wherever it later shows up. */
const SECRET_KEY_PATTERN =
  /(PASSWORD|PASSWD|PWD|PASSPHRASE|SECRET|TOKEN|CREDENTIALS?|PRIVATE_?KEY|API_?KEY|ACCESS_?KEY|SECRET_?KEY|SIGNING|SIGNATURE|SALT|JWT|BEARER|COOKIE|DSN|_KEY$|^KEY$)/i;

/**
 * Keys the pattern above matches by accident, whose values are not secrets.
 *
 * `PWD` is in essentially every shell environment and its value is the current
 * directory - so Twin masked the project path out of every log line that
 * mentioned it, including `cannot open <redacted>/data.db`. The log tail exists
 * to hand over the boot-failure diagnosis, and this quietly deleted it. (The
 * `PWD` in the pattern is there for `DB_PWD` and `MYSQL_PWD`, which are real.)
 */
const NEVER_SECRET_KEYS = new Set(["PWD", "OLDPWD", "CWD", "INIT_CWD", "npm_config_local_prefix"]);

/**
 * A value this short, or this common, appears in ordinary log lines all day -
 * masking it would turn the log into confetti and hide the diagnosis the log
 * exists to provide.
 */
const MIN_SECRET_LENGTH = 6;
const NEVER_MASK = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "none",
  "empty",
  "default",
  "changeme",
  "secret",
  "password",
  "development",
  "production",
  "staging",
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "postgres",
  "mysql",
  "redis",
  "sqlite"
]);

/** `postgres://app:s3cret@db/app` -> `postgres://app:<redacted>@db/app`. Keeps the host: that part is the diagnosis. */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi;

/** `password=s3cret`, `"api_key": "abc"`, `token: abc`. */
const SECRET_ASSIGNMENT =
  /([a-z0-9_.-]*(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|signature|session[_-]?id)[a-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;}&]+)/gi;

/** `Authorization: Bearer eyJhbGci...` - a header, so there's no `=` for SECRET_ASSIGNMENT to anchor on. */
const BEARER_TOKEN = /\b(bearer\s+)([a-z0-9._~+/=-]{8,})/gi;

/**
 * Guards SECRET_ASSIGNMENT against eating ordinary prose: "Invalid token:
 * malformed" matches the pattern, but `malformed` is plainly not a credential.
 * Real secrets carry a digit, a symbol, or enough length to be random.
 */
function looksLikeACredential(value: string): boolean {
  return value.length >= 12 || /\d/.test(value) || /[^A-Za-z0-9]/.test(value);
}

/**
 * The env values worth masking out of log output - the actual secrets this run
 * handed to the app, which is far more reliable than pattern-matching whatever
 * shape the app chose to print them in.
 */
export function collectSecretEnvValues(env: Readonly<Record<string, string | undefined>>): string[] {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || NEVER_SECRET_KEYS.has(key) || !SECRET_KEY_PATTERN.test(key)) continue;
    const trimmed = value.trim();
    if (trimmed.length < MIN_SECRET_LENGTH) continue;
    if (NEVER_MASK.has(trimmed.toLowerCase())) continue;
    if (/^\d+$/.test(trimmed)) continue; // a port or a timeout, not a credential
    values.add(trimmed);
  }
  return [...values];
}

/**
 * Builds the line-level redactor. Longest secrets first, so masking one that
 * contains another (`<password>` inside `DATABASE_URL`) can't leave the
 * remainder of the longer one exposed.
 */
export function createLogRedactor(secretValues: readonly string[] = []): (line: string) => string {
  const secrets = [...new Set(secretValues)]
    .filter((value) => value.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);

  return (line: string): string => {
    if (line.length === 0) return line;

    let out = line;
    for (const secret of secrets) {
      if (out.includes(secret)) out = out.split(secret).join(MASK);
    }

    out = out.replace(URL_CREDENTIALS, (_m, scheme: string, user: string) => `${scheme}${user}:${MASK}@`);
    out = out.replace(SECRET_ASSIGNMENT, (match, key: string, separator: string, value: string) =>
      looksLikeACredential(value) ? `${key}${separator}${MASK}` : (match as string)
    );
    out = out.replace(BEARER_TOKEN, (_m, prefix: string) => `${prefix}${MASK}`);
    return out;
  };
}
