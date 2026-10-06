import { describe, expect, it } from "vitest";

import { evaluateSaveExpression, SaveExpressionError } from "./saveExpression.js";

describe("evaluateSaveExpression", () => {
  it("extracts a JSONPath from the body", () => {
    expect(evaluateSaveExpression("$.id", { id: "abc" }, {})).toBe("abc");
  });

  it("stringifies a non-string JSONPath result", () => {
    expect(evaluateSaveExpression("$.count", { count: 3 }, {})).toBe("3");
  });

  it("extracts a header by name, case-insensitively", () => {
    expect(evaluateSaveExpression("header:Set-Cookie", undefined, { "set-cookie": "sid=abc" })).toBe("sid=abc");
  });

  it("takes the first value when a header is an array", () => {
    expect(evaluateSaveExpression("header:X-Thing", undefined, { "x-thing": ["a", "b"] })).toBe("a");
  });

  it("throws SaveExpressionError when the header is missing", () => {
    expect(() => evaluateSaveExpression("header:Missing", undefined, {})).toThrow(SaveExpressionError);
  });

  it("throws SaveExpressionError for an unsupported expression shape", () => {
    expect(() => evaluateSaveExpression("nonsense", undefined, {})).toThrow(SaveExpressionError);
  });
});
