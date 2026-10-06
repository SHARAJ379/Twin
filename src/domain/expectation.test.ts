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
});
