// The single most important safety rule (§9.1, invariant I8): vibe-coded
// apps very often have a live Supabase/Neon/Mongo URL sitting in .env.
// Twin must refuse to run test traffic against it by default.

// Every datastore/broker keyword a connection setting is usually named after.
// Shared by the "*_URL / *_DSN" rule and the "*_HOST" rule below.
const SERVICE_KEYWORDS = [
  "DATABASE",
  "DB",
  "PG",
  "POSTGRES",
  "POSTGRESQL",
  "MYSQL",
  "MARIADB",
  "SQLITE",
  "MSSQL",
  "SQLSERVER",
  "ORACLE",
  "MONGO",
  "MONGODB",
  "DOCUMENTDB",
  "COSMOS",
  "COSMOSDB",
  "DYNAMODB",
  "FIRESTORE",
  "SUPABASE",
  "PLANETSCALE",
  "NEON",
  "TURSO",
  "LIBSQL",
  "UPSTASH",
  "PRISMA",
  "COCKROACH",
  "COCKROACHDB",
  "RDS",
  "REDSHIFT",
  "BIGQUERY",
  "SNOWFLAKE",
  "CLICKHOUSE",
  "CASSANDRA",
  "SCYLLA",
  "TIMESCALE",
  "INFLUX",
  "INFLUXDB",
  "NEO4J",
  "REDIS",
  "MEMCACHED",
  "ELASTIC",
  "ELASTICSEARCH",
  "OPENSEARCH",
  "SOLR",
  "KAFKA",
  "RABBITMQ",
  "AMQP",
  "NATS",
  "QDRANT",
  "PINECONE",
  "WEAVIATE",
  "MILVUS"
].join("|");

// Anchored to a database/service keyword, not just a "_URL"/"_URI" suffix:
// CI runners (GitHub Actions among them) set plenty of ambient *_URL vars of
// their own (GITHUB_API_URL, GITHUB_SERVER_URL, ...) that have nothing to do
// with a database and would otherwise false-positive on every CI run.
const SUSPICIOUS_KEY_PATTERN = new RegExp(`(^|_)(${SERVICE_KEYWORDS}|DSN|CONNECTION_STRING)(_|$)`, "i");

// Half the real-world configs don't use a URL at all - they split the
// connection across DB_HOST/DB_USER/DB_PASSWORD, use libpq's PGHOST, or list
// seed nodes (KAFKA_BOOTSTRAP_SERVERS). Those values are bare hostnames, so
// they never parsed as a URL and used to sail straight past the refusal.
const SERVICE_TOKEN_PATTERN = new RegExp(`(^|_)(${SERVICE_KEYWORDS})(_|$)`, "i");
const HOST_TOKEN_PATTERN =
  /(^|_)(HOSTADDR|HOSTNAME|HOST|SERVERNAME|SERVERS|SERVER|ENDPOINTS?|ADDRESS|ADDR|BROKERS?|SEEDS?|NODES?|CLUSTER)(_|$)/i;
/** PGHOST and friends: no underscore to delimit the service keyword from the host one. */
const GLUED_HOST_KEY_PATTERN = new RegExp(
  `^(${SERVICE_KEYWORDS})(HOSTADDR|HOSTNAME|HOST|SERVERNAME|SERVER|ENDPOINT|ADDRESS|ADDR)$`,
  "i"
);

/**
 * A key whose *value* is expected to be a bare hostname rather than a URL.
 * Both halves are required - a lone HOSTNAME/HOST/SERVER is set ambiently on
 * most Linux CI runners and would false-positive on every run.
 */
function isHostShapedKey(key: string): boolean {
  return GLUED_HOST_KEY_PATTERN.test(key) || (SERVICE_TOKEN_PATTERN.test(key) && HOST_TOKEN_PATTERN.test(key));
}

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
    normalized === "host.docker.internal" || // the dev machine itself, reached from inside a container
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  );
}

/** "[::1]:6379" -> "[::1]", "db.example.com:5432" -> "db.example.com", "db" -> "db". */
function stripPort(hostPort: string): string {
  const trimmed = hostPort.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(0, end + 1);
  }
  const colon = trimmed.indexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

/** A bare value is only read as a hostname if it couldn't be a database name, a path, or a port. */
function looksLikeBareHostname(host: string): boolean {
  // The dot is the whole test: it separates `DB_HOST=prod.db.example.com`
  // (clearly a real host) from `DB_HOST=postgres` (a docker-compose service
  // name or a local alias), which must not trip the refusal.
  return /^[a-z0-9][a-z0-9._-]*$/i.test(host) && host.includes(".");
}

/**
 * Every hostname a connection setting points at - plural because mongo and
 * kafka take comma-separated seed lists ("mongodb://a.net:27017,b.net:27017/db").
 * Deliberately conservative: anything that isn't shaped like a connection
 * target (a sentence, a unix socket path, a bare word) yields nothing rather
 * than being guessed at.
 */
function hostsIn(value: string, allowBareHost: boolean): string[] {
  let rest = value.trim();
  if (rest.length === 0 || /\s/.test(rest)) return [];
  rest = rest.replace(/^jdbc:/i, ""); // jdbc:postgresql://host:5432/db

  const schemeIdx = rest.indexOf("://");
  if (schemeIdx !== -1) {
    if (!/^[a-z][a-z0-9+.-]*$/i.test(rest.slice(0, schemeIdx))) return [];
    rest = rest.slice(schemeIdx + 3);
  } else if (!allowBareHost) {
    return [];
  }

  const authorityEnd = rest.search(/[/?#]/);
  let authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  // lastIndexOf: a password may itself contain an "@", and the authority's
  // final "@" is always the userinfo separator.
  const at = authority.lastIndexOf("@");
  if (at !== -1) authority = authority.slice(at + 1);

  const hosts = authority
    .split(",")
    .map(stripPort)
    .filter((host) => host.length > 0);

  // With no scheme to vouch for it, the value has to look like a hostname on its own.
  return schemeIdx === -1 ? hosts.filter(looksLikeBareHostname) : hosts;
}

/**
 * Env vars that look like they point a datastore somewhere non-local - either
 * as a connection URL/DSN or as a split-out `*_HOST`. False negatives here are
 * cheaper than refusing to run on a false positive, so a value that isn't
 * shaped like a connection target at all is skipped rather than guessed at.
 */
export function scanForRemoteResources(env: Readonly<Record<string, string>>): RemoteResourceRef[] {
  const found: RemoteResourceRef[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    const hostKey = isHostShapedKey(key);
    if (!hostKey && !SUSPICIOUS_KEY_PATTERN.test(key)) continue;
    for (const host of hostsIn(value, hostKey)) {
      // A seed list may repeat a host, and two keys may point at the same one -
      // the refusal message reads better without the duplicates.
      if (isLocalHost(host) || seen.has(`${key}|${host}`)) continue;
      seen.add(`${key}|${host}`);
      found.push({ key, host });
    }
  }
  return found;
}

/** Third-party keys (§9.2) warrant a warning, not a refusal - a scenario run may trigger real Stripe/email/SMS/LLM calls. */
export function scanForThirdPartyKeys(env: Readonly<Record<string, string>>): string[] {
  return Object.keys(env).filter((key) => THIRD_PARTY_KEY_PATTERN.test(key));
}
