import { describe, expect, it } from "vitest";

import { scanForRemoteResources, scanForThirdPartyKeys } from "./safetyScan.js";

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
