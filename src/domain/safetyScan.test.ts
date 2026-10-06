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
