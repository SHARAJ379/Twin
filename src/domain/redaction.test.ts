import { describe, expect, it } from "vitest";

import { redactBody, redactHeaders } from "./redaction.js";

describe("redactHeaders", () => {
  it("keeps allowlisted headers verbatim", () => {
    const out = redactHeaders({ "content-type": "application/json", "content-length": "42" });
    expect(out).toEqual({ "content-type": "application/json", "content-length": "42" });
  });

  it("drops headers that aren't on the allowlist", () => {
    const out = redactHeaders({ "x-request-id": "abc", date: "now" });
    expect(out).toEqual({});
  });

  it("redacts a Set-Cookie value but keeps the cookie name and attributes", () => {
    const out = redactHeaders({ "set-cookie": "sid=d71f18b0e4fb; Path=/; HttpOnly" });
    expect(out["set-cookie"]).toBe("sid=<redacted>; Path=/; HttpOnly");
  });

  it("redacts every value in a request Cookie header", () => {
    const out = redactHeaders({ cookie: "sid=abc123; other=def456" });
    expect(out["cookie"]).toBe("sid=<redacted>; other=<redacted>");
  });

  it("redacts Authorization entirely", () => {
    const out = redactHeaders({ authorization: "Bearer sometoken" });
    expect(out["authorization"]).toBe("<redacted>");
  });

  it("redacts extra user-configured header names", () => {
    const out = redactHeaders({ "x-api-key": "secret" }, ["x-api-key"]);
    expect(out["x-api-key"]).toBe("<redacted>");
  });
});

describe("redactBody", () => {
  it("masks secret-ish JSON keys but keeps other fields", () => {
    const out = redactBody(JSON.stringify({ email: "a@test.com", password: "pw12345" }));
    expect(JSON.parse(out!)).toEqual({ email: "a@test.com", password: "<redacted>" });
  });

  it("masks nested secret keys", () => {
    const out = redactBody(JSON.stringify({ user: { token: "xyz" } }));
    expect(JSON.parse(out!)).toEqual({ user: { token: "<redacted>" } });
  });

  it("leaves non-JSON text alone (other than truncation)", () => {
    expect(redactBody("hello world")).toBe("hello world");
  });

  it("truncates long bodies to 2KB", () => {
    const big = "x".repeat(3000);
    const out = redactBody(big)!;
    expect(out.length).toBeLessThan(3000);
    expect(out.endsWith("<truncated>")).toBe(true);
  });

  it("passes through undefined", () => {
    expect(redactBody(undefined)).toBeUndefined();
  });

  /**
   * A form body is what an HTML login and an OAuth token endpoint send, and it
   * used to reach report.json and results.json verbatim because only JSON was
   * masked - so the most likely first step of any scenario wrote a real
   * password to disk under a "safe to paste" promise.
   */
  it("masks secret fields in a form-encoded body", () => {
    expect(redactBody("email=a%40test.com&password=hunter2")).toBe("email=a%40test.com&password=<redacted>");
  });

  it("keeps a form body's other fields, its encoding and its order", () => {
    expect(redactBody("name=A+B&access_token=abc.def&page=2")).toBe("name=A+B&access_token=<redacted>&page=2");
  });

  it("masks a form value that itself contains = (an unencoded base64 token)", () => {
    expect(redactBody("refresh_token=ab==&id=7")).toBe("refresh_token=<redacted>&id=7");
  });

  /**
   * The exact-name list this replaced held only password/token/secret/key/
   * authorization, so every one of these - the names real APIs actually use -
   * went into the report in the clear.
   */
  it.each([
    "access_token",
    "accessToken",
    "refreshToken",
    "apiKey",
    "api_key",
    "X-Auth-Token",
    "client_secret",
    "password_confirmation",
    "sessionId",
    "privateKey",
    "signature"
  ])("masks %s", (key) => {
    const out = redactBody(JSON.stringify({ [key]: "s3cret-value", keep: "visible" }));
    expect(JSON.parse(out!)).toEqual({ [key]: "<redacted>", keep: "visible" });
  });

  /**
   * Over-redaction isn't free either: the body is evidence a human has to
   * read, so names that merely contain a short secret-ish word must survive.
   */
  it.each(["author", "keyword", "monkey", "authorName", "keys_pressed", "tokenizer_version"])(
    "leaves %s alone",
    (key) => {
      const out = redactBody(JSON.stringify({ [key]: "visible" }));
      expect(JSON.parse(out!)).toEqual({ [key]: "visible" });
    }
  );

  it("still masks a bare key/auth field, where the whole name is the secret", () => {
    const out = redactBody(JSON.stringify({ key: "abc", auth: "def", pwd: "ghi" }));
    expect(JSON.parse(out!)).toEqual({ key: "<redacted>", auth: "<redacted>", pwd: "<redacted>" });
  });

  it("masks a caller-supplied extra key name, however it's spelled", () => {
    const out = redactBody(JSON.stringify({ "x-custom-id": "abc" }), ["X_CUSTOM_ID"]);
    expect(JSON.parse(out!)).toEqual({ "x-custom-id": "<redacted>" });
  });

  it("does not mistake ordinary prose for a form body", () => {
    expect(redactBody("hello world = not a form")).toBe("hello world = not a form");
  });
});
