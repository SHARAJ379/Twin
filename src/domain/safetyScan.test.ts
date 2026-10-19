import { describe, expect, it } from "vitest";

import { findDatastoreSettings, scanForRemoteResources, scanForThirdPartyKeys, scanSourceForRemoteResources } from "./safetyScan.js";

describe("scanForRemoteResources", () => {
  it("flags a DATABASE_URL pointing at a real host", () => {
    const found = scanForRemoteResources({ DATABASE_URL: "postgres://user:pass@db.supabase.co:5432/postgres" });
    expect(found).toEqual([{ key: "DATABASE_URL", host: "db.supabase.co" }]);
  });

  it("flags a mongodb+srv cluster URL", () => {
    const found = scanForRemoteResources({ MONGODB_URI: "mongodb+srv://user:pass@cluster0.abcde.mongodb.net/mydb" });
    expect(found).toHaveLength(1);
  });

  it("does not flag localhost, 127.0.0.1, ::1, or *.local", () => {
    const found = scanForRemoteResources({
      DATABASE_URL: "postgres://localhost:5432/app",
      REDIS_URL: "redis://127.0.0.1:6379",
      MONGO_URL: "mongodb://[::1]:27017/app",
      SUPABASE_URL: "http://myapp.local:8000"
    });
    expect(found).toEqual([]);
  });

  // Found in the pre-release audit: the host was read as ending at the first
  // "/", so the password's "/" made `admin` the host - dotless, so local.
  it.each([
    ["a /", "postgres://admin:p/ss@db.prod.example-corp.com:5432/app"],
    ["a ?", "postgres://admin:p?ss@db.prod.example-corp.com/app"],
    ["a #", "postgres://admin:p#ss@db.prod.example-corp.com/app"],
    ["several", "mongodb+srv://app:a/b?c#d@cluster0.abcde.example-corp.com/app?retryWrites=true"]
  ])("flags a real host whose password holds %s, unencoded", (_label, value) => {
    const found = scanForRemoteResources({ DATABASE_URL: value });
    expect(found.map((ref) => ref.host)).toEqual([value.includes("cluster0") ? "cluster0.abcde.example-corp.com" : "db.prod.example-corp.com"]);
  });

  it("still reads an @ in a query, or after a real port, as part of the query", () => {
    expect(
      scanForRemoteResources({
        DATABASE_URL: "postgres://localhost:5432/app?user=ops@example-corp.com",
        REDIS_URL: "redis://localhost/0?client=ci@example-corp.com"
      })
    ).toEqual([]);
  });

  it("ignores keys that don't look like a connection string", () => {
    const found = scanForRemoteResources({ NODE_ENV: "production", PORT: "3000" });
    expect(found).toEqual([]);
  });

  it("skips a value that doesn't parse as a URL rather than guessing", () => {
    const found = scanForRemoteResources({ DATABASE_URL: "not a url at all" });
    expect(found).toEqual([]);
  });

  it("flags multiple suspicious vars independently", () => {
    const found = scanForRemoteResources({
      DATABASE_URL: "postgres://host-a.acme-corp.io/db",
      REDIS_URL: "redis://host-b.acme-corp.io:6379"
    });
    expect(found).toHaveLength(2);
  });

  it("does not flag GitHub Actions' own ambient *_URL vars (regression: broke every CI run)", () => {
    const found = scanForRemoteResources({
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_GRAPHQL_URL: "https://api.github.com/graphql"
    });
    expect(found).toEqual([]);
  });

  it("still flags a bare DB_URL/DSN without a named provider", () => {
    const found = scanForRemoteResources({
      DB_URL: "postgres://host.acme-corp.io/app",
      APP_DSN: "sentry://host.acme-corp.io/1"
    });
    expect(found).toHaveLength(2);
  });

  it("flags a split-out host setting, which has no URL to parse", () => {
    const found = scanForRemoteResources({ DB_HOST: "prod-db.acme-corp.io", DB_USER: "app", DB_PASSWORD: "hunter2" });
    expect(found).toEqual([{ key: "DB_HOST", host: "prod-db.acme-corp.io" }]);
  });

  it("flags libpq's glued PGHOST", () => {
    expect(scanForRemoteResources({ PGHOST: "prod.db.acme-corp.io" })).toEqual([
      { key: "PGHOST", host: "prod.db.acme-corp.io" }
    ]);
  });

  it("flags a host setting that carries a port", () => {
    expect(scanForRemoteResources({ MYSQL_HOST: "db.acme-corp.io:3306" })).toEqual([
      { key: "MYSQL_HOST", host: "db.acme-corp.io" }
    ]);
  });

  it("flags every host in a comma-separated seed list, deduplicated", () => {
    const found = scanForRemoteResources({ KAFKA_BOOTSTRAP_SERVERS: "b1.acme-corp.io:9092,b2.acme-corp.io:9092,b1.acme-corp.io:9092" });
    expect(found).toEqual([
      { key: "KAFKA_BOOTSTRAP_SERVERS", host: "b1.acme-corp.io" },
      { key: "KAFKA_BOOTSTRAP_SERVERS", host: "b2.acme-corp.io" }
    ]);
  });

  it("flags a jdbc connection string", () => {
    expect(scanForRemoteResources({ DATABASE_URL: "jdbc:postgresql://db.acme-corp.io:5432/app" })).toEqual([
      { key: "DATABASE_URL", host: "db.acme-corp.io" }
    ]);
  });

  it("does not flag a local or container-local host setting", () => {
    const found = scanForRemoteResources({
      DB_HOST: "localhost",
      REDIS_HOST: "127.0.0.1",
      MONGO_HOST: "host.docker.internal",
      MYSQL_HOST: "db.local"
    });
    expect(found).toEqual([]);
  });

  it("does not read a bare word as a hostname - it's usually a service or database name", () => {
    // `DB_HOST=postgres` is a docker-compose service name; DATABASE_NAME and
    // REDIS_PASSWORD are not hosts at all. Guessing here would refuse to run
    // on a perfectly local setup, which is worse than missing one.
    const found = scanForRemoteResources({
      DB_HOST: "postgres",
      DATABASE_NAME: "myapp",
      REDIS_PASSWORD: "s3cret",
      DB_SERVER: "mssql"
    });
    expect(found).toEqual([]);
  });

  it("lets an explicitly vouched-for host through while still checking the rest", () => {
    const found = scanForRemoteResources(
      { DATABASE_URL: "postgres://user:pass@allowed.acme-corp.io/app", REDIS_URL: "redis://other.acme-corp.io:6379" },
      { allowedHosts: ["allowed.acme-corp.io"] }
    );
    expect(found).toEqual([{ key: "REDIS_URL", host: "other.acme-corp.io" }]);
  });

  it("treats a leading dot as a domain suffix, so a whole cluster takes one entry", () => {
    const found = scanForRemoteResources(
      { MONGODB_URI: "mongodb://a.cluster0.mongodb.net:27017,b.cluster0.mongodb.net:27017/app" },
      { allowedHosts: [".mongodb.net"] }
    );
    expect(found).toEqual([]);
  });

  it("matches a vouched host case-insensitively but never by partial name", () => {
    expect(scanForRemoteResources({ DB_HOST: "Prod.Example.COM" }, { allowedHosts: ["prod.acme-corp.io"] })).toEqual([]);
    // "acme-corp.io" must not vouch for "evil-acme-corp.io" or a subdomain.
    expect(scanForRemoteResources({ DB_HOST: "evil-acme-corp.io" }, { allowedHosts: ["acme-corp.io"] })).toHaveLength(1);
    expect(scanForRemoteResources({ DB_HOST: "sub.acme-corp.io" }, { allowedHosts: ["acme-corp.io"] })).toHaveLength(1);
  });

  it("ignores an empty allowlist entry rather than vouching for everything", () => {
    expect(scanForRemoteResources({ DB_HOST: "prod.acme-corp.io" }, { allowedHosts: ["", "  "] })).toHaveLength(1);
  });

  it("does not flag a unix socket path or an ambient HOSTNAME", () => {
    const found = scanForRemoteResources({
      HOSTNAME: "fv-az1234-567", // set on every Linux CI runner
      HOST: "runner.internal.acme-corp.io",
      PGHOST_DIR: "/var/run/postgresql",
      DATABASE_URL: "/var/run/postgresql/.s.PGSQL.5432"
    });
    expect(found).toEqual([]);
  });
});

describe("scanForThirdPartyKeys", () => {
  it("flags Stripe/SendGrid/OpenAI-shaped keys", () => {
    const found = scanForThirdPartyKeys({ STRIPE_SECRET_KEY: "sk_live_x", SENDGRID_API_KEY: "x", OPENAI_API_KEY: "x" });
    expect(found.sort()).toEqual(["OPENAI_API_KEY", "SENDGRID_API_KEY", "STRIPE_SECRET_KEY"]);
  });

  it("ignores unrelated keys", () => {
    expect(scanForThirdPartyKeys({ NODE_ENV: "production" })).toEqual([]);
  });
});

/**
 * Found by an external audit feeding the scan real-world names. It started
 * from the variable's name, so every one of these walked past it and Twin
 * would have written test data or uploads into the real service.
 */
describe("scanForRemoteResources: real-world names the name-based rule missed", () => {
  it("flags a datastore URL by its scheme, whatever the variable is called", () => {
    const found = scanForRemoteResources({
      ATLAS_URI: "mongodb+srv://u:p@cluster0.abcde.mongodb.net/app",
      SOMETHING_ELSE: "rediss://default:x@eu1-fancy.upstash.io:6379"
    });
    expect(found.map((r) => r.host).sort()).toEqual(["cluster0.abcde.mongodb.net", "eu1-fancy.upstash.io"]);
  });

  it.each([
    ["KV_URL", "redis://default:x@eu1-kv.upstash.io:6379", "eu1-kv.upstash.io"],
    ["KV_REST_API_URL", "https://eu1-kv.upstash.io", "eu1-kv.upstash.io"],
    ["CONVEX_URL", "https://happy-otter-123.convex.cloud", "happy-otter-123.convex.cloud"],
    ["CLOUDINARY_URL", "cloudinary://123:abc@my-cloud", "my-cloud"],
    ["S3_BUCKET", "acme-prod-uploads", "acme-prod-uploads"],
    ["AWS_S3_BUCKET_NAME", "acme-uploads", "acme-uploads"],
    ["FIREBASE_PROJECT_ID", "acme-app", "acme-app"],
    ["GOOGLE_APPLICATION_CREDENTIALS", "./service-account.json", "./service-account.json"],
    ["DB_HOST", "prod-db", "prod-db"]
  ])("flags %s", (key, value, host) => {
    expect(scanForRemoteResources({ [key]: value }).map((r) => r.host)).toEqual([host]);
  });

  it("still leaves a docker-compose service name alone", () => {
    expect(scanForRemoteResources({ DB_HOST: "postgres", REDIS_HOST: "cache" })).toEqual([]);
  });

  it("doesn't flag a bucket or Firebase project when the SDK is pointed at a local emulator or endpoint", () => {
    expect(scanForRemoteResources({ FIREBASE_PROJECT_ID: "demo", FIRESTORE_EMULATOR_HOST: "localhost:8080" })).toEqual([]);
    expect(scanForRemoteResources({ S3_BUCKET: "uploads", AWS_ENDPOINT_URL: "http://localhost:4566" })).toEqual([]);
  });

  it("lets a vouched-for bucket through", () => {
    expect(scanForRemoteResources({ S3_BUCKET: "acme-staging" }, { allowedHosts: ["acme-staging"] })).toEqual([]);
  });

  it("doesn't read an ordinary https API base URL as a datastore", () => {
    expect(scanForRemoteResources({ ANTHROPIC_BASE_URL: "https://api.anthropic.com", NEXT_PUBLIC_SITE: "https://acme.com" })).toEqual([]);
  });
});

describe("scanSourceForRemoteResources", () => {
  it("flags a connection string hardcoded in the source", () => {
    const found = scanSourceForRemoteResources([
      { path: "server.js", content: 'mongoose.connect("mongodb+srv://u:p@cluster0.abcde.mongodb.net/app");' }
    ]);
    expect(found).toEqual([{ key: "a connection string in the source", host: "cluster0.abcde.mongodb.net", source: "server.js" }]);
  });

  it("ignores local, templated and non-datastore URLs", () => {
    const found = scanSourceForRemoteResources([
      {
        path: "db.js",
        content: [
          'const url = process.env.MONGO_URI || "mongodb://localhost:27017/app";',
          "const tpl = `postgres://${user}@${host}/db`;",
          'fetch("https://api.example.com/v1");'
        ].join("\n")
      }
    ]);
    expect(found).toEqual([]);
  });
});

describe("scanForThirdPartyKeys: credentials, not configuration", () => {
  it.each(["RESEND_API_KEY", "PAYPAL_CLIENT_SECRET", "BRAINTREE_PRIVATE_KEY", "MAILCHIMP_API_KEY", "SLACK_WEBHOOK_URL", "AWS_SECRET_ACCESS_KEY"])(
    "warns about %s",
    (key) => {
      expect(scanForThirdPartyKeys({ [key]: "x" })).toEqual([key]);
    }
  );

  it("doesn't warn about a client setting that sends nothing on its own", () => {
    expect(scanForThirdPartyKeys({ ANTHROPIC_BASE_URL: "https://api.anthropic.com", STRIPE_API_VERSION: "2024-06-20" })).toEqual([]);
  });

  it("doesn't warn about a key that is declared but empty", () => {
    expect(scanForThirdPartyKeys({ OPENAI_API_KEY: "" })).toEqual([]);
  });
});

/**
 * Found by an external audit: once docker-compose.yml was scanned, every
 * Compose project was refused - `postgres://u:p@db:5432` names a container,
 * and the dotless-is-local rule only applied to bare host values. And a
 * fixture's `cluster0.example.net` blocked a run, though RFC 2606 reserves it.
 */
describe("names that can't be a remote production server", () => {
  it("treats a dotless host inside a URL as a compose service, like a bare one", () => {
    expect(scanForRemoteResources({ DATABASE_URL: "postgres://app:pw@db:5432/app", REDIS_URL: "redis://redis:6379" })).toEqual([]);
    expect(
      scanSourceForRemoteResources([{ path: "docker-compose.yml", content: '      DATABASE_URL: "postgres://app:pw@db:5432/app"' }])
    ).toEqual([]);
  });

  it("still refuses a dotless host that names production, and any dotted one", () => {
    expect(scanForRemoteResources({ DATABASE_URL: "postgres://app@prod-db:5432/app" }).map((r) => r.host)).toEqual(["prod-db"]);
    expect(scanForRemoteResources({ DATABASE_URL: "postgres://app@10.0.4.12:5432/app" }).map((r) => r.host)).toEqual(["10.0.4.12"]);
  });

  // The deliberate policy (SECURITY.md, "What counts as local"): a short name is a local container
  // unless it names a shared environment outright.
  it.each(["staging-db", "db-staging", "stg-postgres", "prod2-db", "uat_db", "preprod", "primary", "live-redis"])(
    "refuses the dotless shared-environment name %s, bare or in a URL",
    (host) => {
      expect(scanForRemoteResources({ DB_HOST: host }).map((r) => r.host)).toEqual([host]);
      expect(scanForRemoteResources({ DATABASE_URL: `postgres://app@${host}:5432/app` }).map((r) => r.host)).toEqual([host]);
    }
  );

  it.each(["db", "postgres", "analytics", "redis-cache", "mongo1", "my-laptop", "livestream"])(
    "treats the short name %s as a local container",
    (host) => {
      expect(scanForRemoteResources({ DATABASE_URL: `postgres://app@${host}:5432/app` })).toEqual([]);
    }
  );

  it("refuses a Kubernetes cluster's own service DNS, despite the .local suffix", () => {
    const host = "postgres.prod.svc.cluster.local";
    expect(scanForRemoteResources({ DATABASE_URL: `postgres://app@${host}:5432/app` }).map((r) => r.host)).toEqual([host]);
    expect(scanForRemoteResources({ DATABASE_URL: "postgres://app@printer.local:5432/app" })).toEqual([]);
  });

  it.each(["cluster0.example.net", "db.example.com", "example.org", "db.test", "x.example", "nope.invalid"])(
    "never refuses the reserved name %s",
    (host) => {
      expect(scanForRemoteResources({ MONGODB_URI: `mongodb://u:p@${host}/app` })).toEqual([]);
    }
  );
});

/**
 * What decides whether a run says "Twin doesn't remove what the scenario
 * writes": whether the app has a datastore at all - local ones included,
 * which is exactly the dev database that fills up.
 */
describe("findDatastoreSettings", () => {
  const env = (vars: Record<string, string>) => Object.entries(vars).map(([key, value]) => ({ key, value }));

  it("names every datastore setting, local ones included", () => {
    expect(
      findDatastoreSettings(
        env({
          DATABASE_URL: "postgres://localhost:5432/dev",
          DB_HOST: "localhost",
          PGHOST: "127.0.0.1",
          REDIS_URL: "redis://localhost:6379",
          PATH: "/usr/bin"
        }),
        []
      )
    ).toEqual(["DATABASE_URL", "DB_HOST", "PGHOST", "REDIS_URL"]);
  });

  // Found dogfooding: DATABASE_URL=sqlite:///{{shared}}/twin.db is the throwaway
  // database Twin itself creates and removes, yet every run warned it was kept.
  it("names nothing whose effective value is under {{shared}}, even when an overridden source declares a real one", () => {
    expect(
      findDatastoreSettings(
        [
          { key: "DATABASE_URL", value: "postgres://localhost:5432/dev" },
          { key: "DATABASE_URL", value: "sqlite:///{{shared}}/twin.db" },
          { key: "REDIS_URL", value: "redis://localhost:6379" }
        ],
        [],
        { DATABASE_URL: "sqlite:///{{shared}}/twin.db", REDIS_URL: "redis://localhost:6379" }
      )
    ).toEqual(["REDIS_URL"]);
  });

  it("names a connection string whatever the variable is called", () => {
    expect(findDatastoreSettings(env({ ATLAS_URI: "mongodb+srv://u:p@cluster0.example.net/app", STORE: "postgresql://localhost/x" }), [])).toEqual([
      "ATLAS_URI",
      "STORE"
    ]);
  });

  it("names nothing for an empty value, an API URL, or the listen address Twin sets", () => {
    expect(
      findDatastoreSettings(
        env({
          DATABASE_URL: "",
          GITHUB_API_URL: "https://api.github.com",
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          HOSTNAME: "runner",
          HOST: "127.0.0.1",
          BIND_ADDRESS: "127.0.0.1",
          PORT: "3000"
        }),
        []
      )
    ).toEqual([]);
  });

  it("names a file with a connection string in its code, templated or not", () => {
    expect(
      findDatastoreSettings(
        [],
        [
          { path: "db.js", content: 'mongoose.connect("mongodb://localhost:27017/app");' },
          { path: "cache.py", content: 'client = redis.from_url(f"redis://{host}:6379")' },
          { path: "api.js", content: 'fetch("https://api.example.com/items");' }
        ]
      )
    ).toEqual(["db.js", "cache.py"]);
  });
});
