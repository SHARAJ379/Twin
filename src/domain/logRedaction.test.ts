import { describe, expect, it } from "vitest";

import { collectSecretEnvValues, createLogRedactor } from "./logRedaction.js";

describe("collectSecretEnvValues", () => {
  it("collects values of secret-shaped keys", () => {
    const values = collectSecretEnvValues({
      DB_PASSWORD: "sup3rs3cret",
      STRIPE_SECRET_KEY: "sk_live_abc123",
      SESSION_SECRET: "a-long-session-secret",
      JWT_SIGNING_KEY: "signing-key-value"
    });
    expect(values.sort()).toEqual(["a-long-session-secret", "signing-key-value", "sk_live_abc123", "sup3rs3cret"]);
  });

  it("ignores keys that aren't secrets", () => {
    expect(collectSecretEnvValues({ NODE_ENV: "production", PORT: "3000", DATABASE_HOST: "db.example.com" })).toEqual([]);
  });

  it("skips values too short, too common, or purely numeric to mask safely", () => {
    const values = collectSecretEnvValues({
      A_TOKEN: "abc", // 3 chars - would mangle every line containing "abc"
      B_PASSWORD: "password",
      C_SECRET: "changeme",
      D_API_KEY: "12345678",
      E_TOKEN: undefined
    });
    expect(values).toEqual([]);
  });

  it("deduplicates a value reused under two keys", () => {
    expect(collectSecretEnvValues({ A_TOKEN: "shared-secret-value", B_TOKEN: "shared-secret-value" })).toEqual([
      "shared-secret-value"
    ]);
  });
});

describe("createLogRedactor", () => {
  it("masks a known secret value anywhere in the line", () => {
    const redact = createLogRedactor(["sup3rs3cret"]);
    expect(redact("connecting with sup3rs3cret ...")).toBe("connecting with <redacted> ...");
  });

  it("masks the longest secret first, so an overlapping shorter one can't leave a remainder", () => {
    const redact = createLogRedactor(["s3cretpart", "s3cretpart-and-more"]);
    expect(redact("value=s3cretpart-and-more")).toBe("value=<redacted>");
  });

  it("masks credentials in a connection URL but keeps the host, which is the diagnosis", () => {
    const redact = createLogRedactor();
    expect(redact("listening, db=postgres://app:hunter2@db.example.com:5432/app")).toBe(
      "listening, db=postgres://app:<redacted>@db.example.com:5432/app"
    );
  });

  it("masks secret-shaped assignments in any syntax", () => {
    const redact = createLogRedactor();
    expect(redact("DB_PASSWORD=s3cret-value")).toBe("DB_PASSWORD=<redacted>");
    expect(redact('{"api_key": "sk_live_abc123", "ok": true}')).toBe('{"api_key": "<redacted>", "ok": true}');
    expect(redact("session_id: 9f3b1c2d4e5f")).toBe("session_id: <redacted>");
  });

  it("leaves ordinary prose alone even when it mentions a token", () => {
    const redact = createLogRedactor();
    expect(redact("Invalid token: malformed")).toBe("Invalid token: malformed");
    expect(redact("password: required")).toBe("password: required");
  });

  it("masks a bearer token, which has no assignment to anchor on", () => {
    const redact = createLogRedactor();
    expect(redact("authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc")).toBe("authorization: Bearer <redacted>");
  });

  it("returns an empty line untouched", () => {
    expect(createLogRedactor(["secret-value"])("")).toBe("");
  });

  it("is a no-op for a line with nothing secret in it", () => {
    const redact = createLogRedactor(["sup3rs3cret"]);
    expect(redact("GET /health 200 1ms")).toBe("GET /health 200 1ms");
  });

  /**
   * PWD is in essentially every shell environment and its value is a directory
   * path, but the secret-key pattern matched it (it's there for DB_PWD and
   * MYSQL_PWD). Treating the cwd as a secret masked it out of every log line
   * that mentioned it - including `cannot open <cwd>/data.db`, which is the
   * boot-failure diagnosis the log tail exists to deliver.
   */
  it("does not treat the shell's own PWD as a secret", () => {
    const projectDir = "/home/dev/projects/my-app";
    const values = collectSecretEnvValues({ PWD: projectDir, OLDPWD: "/home/dev", INIT_CWD: projectDir });
    expect(values).toEqual([]);

    const redact = createLogRedactor(collectSecretEnvValues({ PWD: projectDir }));
    expect(redact(`Error: cannot open ${projectDir}/data.db`)).toBe(`Error: cannot open ${projectDir}/data.db`);
  });

  it("still treats a real password env var named with PWD as a secret", () => {
    expect(collectSecretEnvValues({ DB_PWD: "s3cret-value" })).toEqual(["s3cret-value"]);
    expect(collectSecretEnvValues({ MYSQL_PWD: "s3cret-value" })).toEqual(["s3cret-value"]);
  });
});
