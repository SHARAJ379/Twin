import { describe, expect, it } from "vitest";

import { scanForRemoteResources, scanForThirdPartyKeys, scanSourceForRemoteResources } from "./safetyScan.js";

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
      DATABASE_URL: "postgres://host-a.example.com/db",
      REDIS_URL: "redis://host-b.example.com:6379"
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
      DB_URL: "postgres://host.example.com/app",
      APP_DSN: "sentry://host.example.com/1"
    });
    expect(found).toHaveLength(2);
  });

  it("flags a split-out host setting, which has no URL to parse", () => {
    const found = scanForRemoteResources({ DB_HOST: "prod-db.example.com", DB_USER: "app", DB_PASSWORD: "hunter2" });
    expect(found).toEqual([{ key: "DB_HOST", host: "prod-db.example.com" }]);
  });

  it("flags libpq's glued PGHOST", () => {
    expect(scanForRemoteResources({ PGHOST: "prod.db.example.com" })).toEqual([
      { key: "PGHOST", host: "prod.db.example.com" }
    ]);
  });

  it("flags a host setting that carries a port", () => {
    expect(scanForRemoteResources({ MYSQL_HOST: "db.example.com:3306" })).toEqual([
      { key: "MYSQL_HOST", host: "db.example.com" }
    ]);
  });

  it("flags every host in a comma-separated seed list, deduplicated", () => {
    const found = scanForRemoteResources({ KAFKA_BOOTSTRAP_SERVERS: "b1.example.com:9092,b2.example.com:9092,b1.example.com:9092" });
    expect(found).toEqual([
      { key: "KAFKA_BOOTSTRAP_SERVERS", host: "b1.example.com" },
      { key: "KAFKA_BOOTSTRAP_SERVERS", host: "b2.example.com" }
    ]);
  });

  it("flags a jdbc connection string", () => {
    expect(scanForRemoteResources({ DATABASE_URL: "jdbc:postgresql://db.example.com:5432/app" })).toEqual([
      { key: "DATABASE_URL", host: "db.example.com" }
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
      { DATABASE_URL: "postgres://user:pass@allowed.example.com/app", REDIS_URL: "redis://other.example.com:6379" },
      { allowedHosts: ["allowed.example.com"] }
    );
    expect(found).toEqual([{ key: "REDIS_URL", host: "other.example.com" }]);
  });

  it("treats a leading dot as a domain suffix, so a whole cluster takes one entry", () => {
    const found = scanForRemoteResources(
      { MONGODB_URI: "mongodb://a.cluster0.mongodb.net:27017,b.cluster0.mongodb.net:27017/app" },
      { allowedHosts: [".mongodb.net"] }
    );
    expect(found).toEqual([]);
  });

  it("matches a vouched host case-insensitively but never by partial name", () => {
    expect(scanForRemoteResources({ DB_HOST: "Prod.Example.COM" }, { allowedHosts: ["prod.example.com"] })).toEqual([]);
    // "example.com" must not vouch for "evil-example.com" or a subdomain.
    expect(scanForRemoteResources({ DB_HOST: "evil-example.com" }, { allowedHosts: ["example.com"] })).toHaveLength(1);
    expect(scanForRemoteResources({ DB_HOST: "sub.example.com" }, { allowedHosts: ["example.com"] })).toHaveLength(1);
  });

  it("ignores an empty allowlist entry rather than vouching for everything", () => {
    expect(scanForRemoteResources({ DB_HOST: "prod.example.com" }, { allowedHosts: ["", "  "] })).toHaveLength(1);
  });

  it("does not flag a unix socket path or an ambient HOSTNAME", () => {
    const found = scanForRemoteResources({
      HOSTNAME: "fv-az1234-567", // set on every Linux CI runner
      HOST: "runner.internal.example.com",
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
