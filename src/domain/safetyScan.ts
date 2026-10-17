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
  // MongoDB Atlas: ATLAS_URI is the name the MERN tutorials teach.
  "ATLAS",
  // Vercel KV / Upstash (KV_URL, KV_REST_API_URL), Convex, Firebase, Appwrite,
  // PocketBase, Xata, Fauna, Hasura - hosted backends a scenario writes into.
  "KV",
  "CONVEX",
  "FIREBASE",
  "APPWRITE",
  "POCKETBASE",
  "XATA",
  "FAUNA",
  "HASURA",
  // Object and media storage: file-consistency uploads land here.
  "S3",
  "R2",
  "MINIO",
  "CLOUDINARY",
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

/**
 * Services a scenario run can make act for real: charge a card, send an
 * email or SMS, post to a channel, spend LLM credit, write to a cloud account.
 */
const THIRD_PARTY_VENDOR_PATTERN = new RegExp(
  `^(${[
    // payments
    "STRIPE",
    "PAYPAL",
    "BRAINTREE",
    "SQUARE",
    "ADYEN",
    "PADDLE",
    "LEMONSQUEEZY",
    "RAZORPAY",
    // email
    "SENDGRID",
    "MAILGUN",
    "POSTMARK",
    "RESEND",
    "MAILCHIMP",
    "MANDRILL",
    "BREVO",
    "SENDINBLUE",
    "MAILJET",
    "SPARKPOST",
    "AWS_SES",
    "SES",
    // SMS, chat and push
    "TWILIO",
    "VONAGE",
    "NEXMO",
    "PLIVO",
    "MESSAGEBIRD",
    "SLACK",
    "DISCORD",
    "TELEGRAM",
    "PUSHER",
    "ONESIGNAL",
    // LLMs
    "OPENAI",
    "ANTHROPIC",
    "GEMINI",
    "GOOGLE_AI",
    "MISTRAL",
    "COHERE",
    "GROQ",
    "REPLICATE",
    // cloud credentials, which reach whatever the app's SDK calls
    "AWS"
  ].join("|")})_`,
  "i"
);

/**
 * Only names that carry a credential: having one is what lets a call go out.
 * `ANTHROPIC_BASE_URL` or `STRIPE_API_VERSION` configure a client and send
 * nothing on their own, and warning on them taught people to ignore the warning.
 */
const CREDENTIAL_NAME_PATTERN = /(^|_)(KEY|SECRET|TOKEN|PASSWORD|PASS|WEBHOOK|SID)(_|$)|API_?KEY|ACCESS_KEY|PRIVATE_KEY/i;

export interface RemoteResourceRef {
  key: string;
  host: string;
  /** Which env source declared this value, when the caller tracked it. */
  source?: string | undefined;
}

/**
 * One declared value of one env var. The scan takes a list of these rather
 * than a merged map because merging has to pick a winner per key, and a scan
 * that only sees winners can be switched off by whichever source happens to
 * lose: a `localhost` placeholder overwriting a real production URL hides the
 * very thing the scan exists to catch. Every declared value gets looked at.
 */
export interface EnvCandidate {
  key: string;
  value: string;
  source?: string | undefined;
}

/** URL.hostname keeps brackets around an IPv6 literal ("[::1]"), unlike every other host form. */
function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function isLocalHost(hostname: string): boolean {
  const normalized = normalizeHost(hostname);
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

/** A dotless name that says outright which environment it is. */
const PRODUCTION_NAME = /(^|[-_])(prod|production|live|primary)([-_]|$)/i;

/** A bare value is only read as a hostname if it couldn't be a database name, a path, or a port. */
function looksLikeBareHostname(host: string): boolean {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(host)) return false;
  // The dot separates `DB_HOST=db.example.com` (clearly a real host) from
  // `DB_HOST=postgres` (a docker-compose service name or a local alias),
  // which must not trip the refusal. But `DB_HOST=prod-db` is a dotless name
  // too - an internal DNS or VPN alias - and it names production outright.
  return host.includes(".") || PRODUCTION_NAME.test(host);
}

/**
 * Schemes that only ever name a datastore or broker. A value like
 * `mongodb+srv://...` is unambiguous whatever the variable is called, and
 * the scan used to start from the name, so ATLAS_URI walked straight past it.
 * http(s) is deliberately absent: every API base URL has it.
 */
const DATASTORE_SCHEMES = new Set([
  "mongodb",
  "mongodb+srv",
  "postgres",
  "postgresql",
  "mysql",
  "mysql2",
  "mariadb",
  "mssql",
  "sqlserver",
  "oracle",
  "redis",
  "rediss",
  "valkey",
  "memcached",
  "amqp",
  "amqps",
  "kafka",
  "nats",
  "libsql",
  "cockroachdb",
  "cassandra",
  "neo4j",
  "neo4j+s",
  "bolt",
  "clickhouse",
  "couchbase",
  "couchbases",
  "cloudinary",
  "s3",
  "gs"
]);

/** `jdbc:postgresql://...` or `postgres://...` -> "postgresql" / "postgres". */
function schemeOf(value: string): string | undefined {
  const match = /^(?:jdbc:)?([a-z][a-z0-9+.-]*):\/\//i.exec(value.trim());
  return match?.[1]?.toLowerCase();
}

/** Whether a value is a datastore connection string by its own shape, regardless of the key it sits under. */
function isDatastoreUrl(value: string): boolean {
  const scheme = schemeOf(value);
  return scheme !== undefined && DATASTORE_SCHEMES.has(scheme);
}

/**
 * Settings that name a real cloud resource without being a URL at all: a
 * bucket (`S3_BUCKET=acme-uploads`), a Firebase project, a GCP service
 * account. file-consistency uploads into the bucket; nothing about the value
 * is a host, so the host rules never saw it.
 *
 * GOOGLE_CLOUD_PROJECT and friends are left out on purpose: Cloud Shell and
 * GCP runners set them ambiently, and on their own they write nothing.
 */
const CLOUD_TARGET_KEY_PATTERN = /((^|_)BUCKET(_NAME)?$|^FIREBASE_PROJECT_ID$|^GOOGLE_APPLICATION_CREDENTIALS$)/i;

/** Emulator and local-endpoint settings that point those same SDKs back at this machine. */
const LOCAL_EMULATOR_KEY_PATTERN =
  /(^|_)EMULATOR_HOST$|^(AWS_ENDPOINT_URL(_S3)?|S3_ENDPOINT(_URL)?|AWS_S3_ENDPOINT|MINIO_ENDPOINT)$/i;

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
 * Hosts the user has explicitly vouched for. An entry beginning with a dot is
 * a domain suffix (`.mongodb.net` covers every shard of a cluster), which is
 * the difference between allowing one datastore and switching the whole check
 * off with `--allow-remote`.
 */
function isAllowedHost(host: string, allowedHosts: readonly string[]): boolean {
  const normalized = normalizeHost(host);
  return allowedHosts.some((entry) => {
    const allowed = normalizeHost(entry);
    if (allowed.length === 0) return false;
    return allowed.startsWith(".") ? normalized === allowed.slice(1) || normalized.endsWith(allowed) : normalized === allowed;
  });
}

/**
 * Env vars that look like they point a datastore somewhere non-local - either
 * as a connection URL/DSN or as a split-out `*_HOST`. False negatives here are
 * cheaper than refusing to run on a false positive, so a value that isn't
 * shaped like a connection target at all is skipped rather than guessed at.
 */
export function scanForRemoteResources(
  env: Readonly<Record<string, string>>,
  options: { allowedHosts?: readonly string[] } = {}
): RemoteResourceRef[] {
  return scanEnvCandidatesForRemoteResources(
    Object.entries(env).map(([key, value]) => ({ key, value })),
    options
  );
}

/**
 * The same scan over every declared value, each carrying where it came from.
 * Prefer this: see EnvCandidate for why a merged map isn't safe to scan.
 */
export function scanEnvCandidatesForRemoteResources(
  candidates: readonly EnvCandidate[],
  options: { allowedHosts?: readonly string[] } = {}
): RemoteResourceRef[] {
  const allowedHosts = options.allowedHosts ?? [];
  const found: RemoteResourceRef[] = [];
  const seen = new Set<string>();
  // An emulator or local endpoint means the SDK talks to this machine, so a
  // bucket or project id alongside it names nothing real.
  const sdkPointedLocal = candidates.some(
    ({ key, value }) =>
      LOCAL_EMULATOR_KEY_PATTERN.test(key) && [...hostsIn(value, true), stripPort(value)].some((host) => isLocalHost(host))
  );
  for (const { key, value, source } of candidates) {
    if (CLOUD_TARGET_KEY_PATTERN.test(key)) {
      const target = value.trim();
      if (target.length === 0 || sdkPointedLocal || isAllowedHost(target, allowedHosts) || seen.has(`${key}|${target}`)) continue;
      seen.add(`${key}|${target}`);
      found.push({ key, host: target, source });
      continue;
    }
    const hostKey = isHostShapedKey(key);
    if (!hostKey && !SUSPICIOUS_KEY_PATTERN.test(key) && !isDatastoreUrl(value)) continue;
    for (const host of hostsIn(value, hostKey)) {
      // A seed list may repeat a host, two keys may point at the same one, and
      // two files may declare the same key - the refusal message reads better
      // without the duplicates.
      if (isLocalHost(host) || isAllowedHost(host, allowedHosts) || seen.has(`${key}|${host}`)) continue;
      seen.add(`${key}|${host}`);
      found.push({ key, host, source });
    }
  }
  return found;
}

/** Third-party keys (§9.2) warrant a warning, not a refusal - a scenario run may trigger real Stripe/email/SMS/LLM calls. */
export function scanForThirdPartyKeys(env: Readonly<Record<string, string>>): string[] {
  return Object.entries(env)
    .filter(([, value]) => value.trim().length > 0)
    .map(([key]) => key)
    .filter((key) => /^SMTP_/i.test(key) || (THIRD_PARTY_VENDOR_PATTERN.test(key) && CREDENTIAL_NAME_PATTERN.test(key)));
}

/**
 * A connection string written into the code itself:
 * `mongoose.connect("mongodb+srv://...")`. No env scan can see it, and it is
 * the shape every quick-start tutorial pastes in. Only quoted literals with a
 * datastore scheme are read, and a templated one (`${host}`, `{{host}}`) is
 * skipped rather than guessed at.
 */
export function scanSourceForRemoteResources(
  files: readonly { path: string; content: string }[],
  options: { allowedHosts?: readonly string[] } = {}
): RemoteResourceRef[] {
  const allowedHosts = options.allowedHosts ?? [];
  const literal = /["'`]((?:jdbc:)?[a-z][a-z0-9+.-]*:\/\/[^"'`\s]+)["'`]/gi;
  const found: RemoteResourceRef[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    for (const match of file.content.matchAll(literal)) {
      const url = match[1]!;
      if (!isDatastoreUrl(url) || /\$\{|\{\{/.test(url)) continue;
      for (const host of hostsIn(url, false)) {
        if (isLocalHost(host) || isAllowedHost(host, allowedHosts) || seen.has(`${file.path}|${host}`)) continue;
        seen.add(`${file.path}|${host}`);
        found.push({ key: "a connection string in the source", host, source: file.path });
      }
    }
  }
  return found;
}
