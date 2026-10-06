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
});
