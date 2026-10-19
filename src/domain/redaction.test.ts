import { describe, expect, it } from "vitest";

import { redactBody, redactHeaders, redactUrl, redactValueForMessage } from "./redaction.js";

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

  // Found in the pre-release audit: only secret *names* were masked in a
  // body, so a credential under an ordinary name was written out whole.
  it("masks a JWT or a prefixed key under an ordinary field name, and leaves ids readable", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl";
    expect(
      JSON.parse(
        redactBody(
          JSON.stringify({
            data: { login: jwt },
            result: "sk_live_PLACEHOLDER-not-a-real-key",
            items: ["ghp_PLACEHOLDERnotarealtoken", "plain"],
            id: "507f1f77bcf86cd799439011",
            uuid: "3f8b2c5a-1d4e-4f6a-9b8c-7d2e1f0a5b3c",
            name: "alice"
          })
        )!
      )
    ).toEqual({
      data: { login: "<redacted>" },
      result: "<redacted>",
      items: ["<redacted>", "plain"],
      id: "507f1f77bcf86cd799439011",
      uuid: "3f8b2c5a-1d4e-4f6a-9b8c-7d2e1f0a5b3c",
      name: "alice"
    });
    expect(redactBody(`next=${jwt}&page=2`)).toBe("next=<redacted>&page=2");
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
    expect(redactValueForMessage(jwt, "$.id")).toBe("<redacted>");
    // Nested in an object it is a JSON value, so quoted there.
    expect(redactValueForMessage({ nested: jwt }, "$.payload")).toBe('{"nested":"<redacted>"}');
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

  /**
   * Checking only the last path segment missed every path whose secret-naming
   * part isn't at the end - `$.tokens[0]` ends in the index `0`.
   */
  it("masks when any segment of the path names a secret, not just the last", () => {
    expect(redactValueForMessage("a3f1c9d2e4b60718293a4b5c6d7e8f90", "$.tokens[0]")).toBe("<redacted>");
    expect(redactValueForMessage("x", "$.session.values[2]")).toBe("<redacted>");
    expect(redactValueForMessage("x", "$.credentials.items[0].value")).toBe("<redacted>");
  });

  /**
   * A value can be a credential whatever the path is called. These two were
   * reproduced in real report output at `$.data.value` and `$.tokens[0]`.
   */
  /**
   * Deliberately unmistakable non-keys. The detection is on the prefix, so a
   * placeholder suffix exercises it exactly as a real key would - and writing
   * realistic ones here got this very commit blocked by GitHub's push
   * protection, which is as good a confirmation as any that the shapes being
   * masked are the shapes that matter.
   */
  it.each([
    "sk_live_PLACEHOLDER-not-a-real-key",
    "sk_test_PLACEHOLDER-not-a-real-key",
    "ghp_PLACEHOLDER-not-a-real-token",
    "xoxb-PLACEHOLDER-not-a-real-token",
    "AKIA-PLACEHOLDER-not-a-real-id",
    "AIza-PLACEHOLDER-not-a-real-key",
    "a3f1c9d2e4b60718293a4b5c6d7e8f90"
  ])("masks the opaque secret %s even at an innocuous path", (secret) => {
    expect(redactValueForMessage(secret, "$.data.value")).toBe("<redacted>");
  });

  it("leaves values a human actually needs to read", () => {
    expect(redactValueForMessage("test-item", "$.data.value")).toBe('"test-item"');
    expect(redactValueForMessage("alice@example.com", "$.data.value")).toBe('"alice@example.com"');
    // A record id is the single most likely thing to be asserted on.
    expect(redactValueForMessage("3f8b2c5a-1d4e-4f6a-9b8c-7d2e1f0a5b3c", "$.data.id")).toBe(
      '"3f8b2c5a-1d4e-4f6a-9b8c-7d2e1f0a5b3c"'
    );
    expect(redactValueForMessage("a message with spaces in it", "$.data.value")).toBe('"a message with spaces in it"');
    expect(redactValueForMessage("0000000000000000000000000000", "$.data.serial")).toBe('"0000000000000000000000000000"');
  });

  /**
   * Over-redaction has a cost too: a jsonPath mismatch on a record id or a file
   * path is the evidence the data- and file-consistency checks rest on, and
   * `expected <redacted>, got <redacted>` can't be diagnosed.
   */
  it("leaves record ids, file paths and fields under a plural collection name readable", () => {
    expect(redactValueForMessage("507f1f77bcf86cd799439011", "$.id")).toBe('"507f1f77bcf86cd799439011"');
    expect(redactValueForMessage("uploads/twin-test-4f2a1b2c.txt", "$.path")).toBe('"uploads/twin-test-4f2a1b2c.txt"');
    expect(redactValueForMessage("Alice", "$.keys[0].owner")).toBe('"Alice"');
    // ...while the collection's own members, and opaque values under it, stay masked
    expect(redactValueForMessage("x", "$.keys[0]")).toBe("<redacted>");
    expect(redactValueForMessage("x", "$.tokens")).toBe("<redacted>");
    expect(redactValueForMessage("a3f1c9d2e4b60718293a4b5c6d7e8f90", "$.keys[0].value")).toBe("<redacted>");
    expect(redactValueForMessage("x", "$.secrets.current")).toBe("<redacted>");
  });

  it("masks a field name the user declared secret", () => {
    expect(redactValueForMessage("plain-value", "$.data.x_custom", ["X-Custom"])).toBe("<redacted>");
  });
});

/**
 * Found by an external audit reading the code: Location was on the header
 * allowlist and kept verbatim, the request path was stored raw, and HTML
 * bodies weren't redacted at all - so magic-link and OAuth logins, a
 * `/verify?token=` step, and a page's CSRF token all reached results.json.
 */
describe("credentials in URLs and HTML", () => {
  it("masks credentials in a redirect's Location, keeping the path and ordinary params", () => {
    const out = redactHeaders({ location: "/dashboard?session=abc123&page=2" });
    expect(out["location"]).toBe("/dashboard?session=<redacted>&page=2");
    expect(redactHeaders({ location: "https://app.test/cb?code=xyz&state=s1" })["location"]).toBe(
      "https://app.test/cb?code=<redacted>&state=<redacted>"
    );
    expect(redactHeaders({ location: "/cb#access_token=t0k&expires_in=3600" })["location"]).toBe(
      "/cb#access_token=<redacted>&expires_in=3600"
    );
  });

  it("masks a token in a request path, and a password in userinfo", () => {
    expect(redactUrl("/verify?token=s3cr3t")).toBe("/verify?token=<redacted>");
    expect(redactUrl("/items?id=7&sort=name")).toBe("/items?id=7&sort=name");
    expect(redactUrl("https://user:hunter2@host/x")).toBe("https://user:<redacted>@host/x");
    expect(redactUrl("/files/report.pdf#page=3")).toBe("/files/report.pdf#page=3");
  });

  it("masks a token that is part of the path, keeping ordinary segments and record ids", () => {
    expect(redactUrl("/reset/s3cr3t-reset-code")).toBe("/reset/<redacted>");
    expect(redactUrl("/verify/123456?next=/home")).toBe("/verify/<redacted>?next=/home");
    expect(redactUrl("/files/a3f1c9d2e4b60718293a4b5c6d7e8f90/download")).toBe("/files/<redacted>/download");
    expect(redactUrl("https://app.test/magic/abc/x")).toBe("https://app.test/magic/<redacted>/x");
    expect(redactUrl("/items/3f8b2c5a-1d4e-4f6a-9b8c-7d2e1f0a5b3c")).toBe("/items/3f8b2c5a-1d4e-4f6a-9b8c-7d2e1f0a5b3c");
    expect(redactUrl("/users/507f1f77bcf86cd799439011/posts/42")).toBe("/users/507f1f77bcf86cd799439011/posts/42");
    expect(redactUrl("/uploads/twin-test-4f2a1b2c.txt")).toBe("/uploads/twin-test-4f2a1b2c.txt");
  });

  it("masks a CSRF token in an HTML hidden field or meta tag, and nothing else", () => {
    const html =
      '<form><input type="hidden" name="_csrf" value="abc"><input name="email" value="a@test.com"></form>' +
      '<meta name="csrf-token" content="def"><input name="csrfmiddlewaretoken" value="ghi">';
    const out = redactBody(html)!;
    expect(out).not.toMatch(/abc|def|ghi/);
    expect(out).toContain('value="a@test.com"');
  });
});
