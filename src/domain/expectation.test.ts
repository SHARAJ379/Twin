import { describe, expect, it } from "vitest";

import { evaluateExpectation } from "./expectation.js";

describe("evaluateExpectation", () => {
  it("passes when no expectation is given", () => {
    expect(evaluateExpectation(undefined, { status: 500 })).toEqual({ passed: true, failures: [] });
  });

  it("checks status against a single value", () => {
    expect(evaluateExpectation({ status: 200 }, { status: 200 }).passed).toBe(true);
    const result = evaluateExpectation({ status: 200 }, { status: 404 });
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toMatch(/expected status 200, got 404/);
  });

  it("checks status against a list of allowed values", () => {
    expect(evaluateExpectation({ status: [200, 201] }, { status: 201 }).passed).toBe(true);
    expect(evaluateExpectation({ status: [200, 201] }, { status: 500 }).passed).toBe(false);
  });

  it("checks bodyContains", () => {
    expect(evaluateExpectation({ bodyContains: "test" }, { status: 200, bodyText: "a test string" }).passed).toBe(true);
    expect(evaluateExpectation({ bodyContains: "test" }, { status: 200, bodyText: "nope" }).passed).toBe(false);
  });

  it("checks jsonPath equality, collecting one failure per mismatched path", () => {
    const result = evaluateExpectation(
      { jsonPath: { "$.id": "abc", "$.count": 2 } },
      { status: 200, body: { id: "abc", count: 3 } }
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(/\$\.count/);
  });

  it("reports a jsonPath that doesn't exist as a failure rather than throwing", () => {
    const result = evaluateExpectation({ jsonPath: { "$.missing": "x" } }, { status: 200, body: {} });
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toMatch(/\$\.missing/);
  });

  it("combines multiple expectation kinds, collecting all failures", () => {
    const result = evaluateExpectation(
      { status: 200, bodyContains: "ok" },
      { status: 404, bodyText: "not found" }
    );
    expect(result.failures).toHaveLength(2);
  });

  /**
   * The comparison used to be JSON.stringify on both sides, which depends on
   * key order - so an app that emitted its fields in a different order than
   * the scenario listed them failed a check it should have passed, and under
   * Twin that reads as a multi-instance bug.
   */
  it("matches a jsonPath object regardless of key order", () => {
    const result = evaluateExpectation(
      { jsonPath: { "$.user": { name: "Ada", id: 1 } } },
      { status: 200, body: { user: { id: 1, name: "Ada" } } }
    );
    expect(result.passed).toBe(true);
  });

  it("matches nested objects and arrays regardless of key order", () => {
    const result = evaluateExpectation(
      { jsonPath: { "$.items": [{ b: 2, a: 1 }] } },
      { status: 200, body: { items: [{ a: 1, b: 2 }] } }
    );
    expect(result.passed).toBe(true);
  });

  it("still fails on a genuinely different value", () => {
    const result = evaluateExpectation(
      { jsonPath: { "$.user": { name: "Ada", id: 1 } } },
      { status: 200, body: { user: { id: 2, name: "Ada" } } }
    );
    expect(result.passed).toBe(false);
  });

  it("still fails when a key is missing, not merely reordered", () => {
    const result = evaluateExpectation(
      { jsonPath: { "$.user": { name: "Ada", id: 1 } } },
      { status: 200, body: { user: { name: "Ada" } } }
    );
    expect(result.passed).toBe(false);
  });

  /**
   * The failure message goes into failedExpectations, from there into a
   * finding's summary and into report.json, results.json, report.md, the fix
   * prompt and the terminal. It used to quote the response value verbatim, so
   * a scenario asserting on a token put the real token in all of them.
   */
  it("does not put the real response value in the failure message for a secret field", () => {
    const result = evaluateExpectation(
      { jsonPath: { "$.token": "expected-token" } },
      { status: 200, body: { token: "eyJSECRETJWT.payload.sig" } }
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).not.toContain("eyJSECRETJWT");
    expect(result.failures.join(" ")).toContain("$.token");
  });

  it("still names the field and shows an ordinary value, so a mismatch stays diagnosable", () => {
    const result = evaluateExpectation(
      { jsonPath: { "$.name": "test-item" } },
      { status: 200, body: { name: "other-item" } }
    );
    expect(result.failures[0]).toContain("$.name");
    expect(result.failures[0]).toContain("other-item");
  });

  it("does not treat an array as equal to an object with the same indexes", () => {
    const result = evaluateExpectation(
      { jsonPath: { "$.v": ["a"] } },
      { status: 200, body: { v: { 0: "a" } } }
    );
    expect(result.passed).toBe(false);
  });
});
