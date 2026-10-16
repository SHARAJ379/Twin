import { describe, expect, it } from "vitest";

import { redactBody, redactHeaders, redactValueForMessage } from "./redaction.js";

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

  /**
   * A field name is app-supplied text and decodeURIComponent throws URIError on
   * a stray `%`. Response bodies are redacted outside any try/catch, so one
   * such body aborted the entire run.
   */
  it("does not throw on a form-shaped body with a malformed percent escape", () => {
    expect(() => redactBody("discount%=10")).not.toThrow();
    expect(redactBody("discount%=10")).toBe("discount%=10");
    expect(redactBody("%=1&%zz=2")).toBe("%=1&%zz=2");
    // An undecodable name is still matched, on its raw text - so a secret
    // field doesn't escape masking by carrying a bad escape.
    expect(redactBody("password%=hunter2")).toBe("password%=<redacted>");
  });

  it("still masks a secret field whose name is percent-encoded", () => {
    expect(redactBody("access%5Ftoken=abc")).toBe("access%5Ftoken=<redacted>");
  });
});

describe("redactValueForMessage", () => {
  /**
   * Expectation-failure messages are quoted in failedExpectations, a finding's
   * summary, report.json/md, the fix prompt and the terminal - all of which
   * promise to be safe to paste publicly. Body redaction never reached them.
   */
  it("masks the value entirely when the path names a secret", () => {
    expect(redactValueForMessage("eyJSECRETJWT.payload.sig", "$.token")).toBe("<redacted>");
    expect(redactValueForMessage("abc", "$.user.password")).toBe("<redacted>");
    expect(redactValueForMessage("abc", "$.data.access_token")).toBe("<redacted>");
    expect(redactValueForMessage("abc", "$.items[0].apiKey")).toBe("<redacted>");
  });

  it("masks a JWT-shaped value even at a path that looks harmless", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    // Rendered as a JSON value, so the mask is a quoted string here.
    expect(redactValueForMessage(jwt, "$.id")).toBe('"<redacted>"');
    expect(redactValueForMessage({ nested: jwt }, "$.payload")).not.toContain("eyJhbGci");
  });

  it("masks secret keys nested inside a mismatched object", () => {
    const out = redactValueForMessage({ email: "a@test.com", token: "abc123" }, "$.user");
    expect(out).toContain("a@test.com");
    expect(out).not.toContain("abc123");
  });

  it("still shows an ordinary mismatched value, so the failure stays diagnosable", () => {
    expect(redactValueForMessage("test-item", "$.name")).toBe('"test-item"');
    expect(redactValueForMessage(42, "$.count")).toBe("42");
  });

  it("truncates a very long value", () => {
    const out = redactValueForMessage("x".repeat(500), "$.description");
    expect(out.endsWith("<truncated>")).toBe(true);
    expect(out.length).toBeLessThan(200);
  });

  it("renders a missing value without throwing", () => {
    expect(redactValueForMessage(undefined, "$.missing")).toBe("undefined");
    expect(redactValueForMessage(null, "$.nothing")).toBe("null");
  });
});
