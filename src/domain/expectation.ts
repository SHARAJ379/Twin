import { extractJsonPath, JsonPathError } from "./jsonPath.js";
import { redactValueForMessage } from "./redaction.js";
import type { Expectation } from "./scenario.js";

export interface ExpectationResult {
  passed: boolean;
  failures: string[];
}

export interface ActualResponse {
  status: number;
  bodyText?: string;
  body?: unknown;
}

/**
 * Structural equality for a `jsonPath:` expectation.
 *
 * This used to compare `JSON.stringify` of both sides, which makes the result
 * depend on key order: `{"a":1,"b":2}` and `{"b":2,"a":1}` are the same JSON
 * value and serialize differently, so an app that happened to emit its fields
 * in a different order than the scenario listed them failed a check it should
 * have passed - and under Twin that reads as a multi-instance bug.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a !== "object") return false;

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

export interface EvaluateOptions {
  /**
   * Field names the user declared secret (`--redact-header` / `redactHeaders`).
   * These reached the body preview but not the failure message, so a field the
   * user had explicitly asked to be redacted was masked in one place in the
   * report and printed in full in another.
   */
  extraSecretKeys?: readonly string[];
}

export function evaluateExpectation(
  expect: Expectation | undefined,
  actual: ActualResponse,
  options: EvaluateOptions = {}
): ExpectationResult {
  if (expect === undefined) return { passed: true, failures: [] };
  const failures: string[] = [];

  if (expect.status !== undefined) {
    const allowed = Array.isArray(expect.status) ? expect.status : [expect.status];
    if (!allowed.includes(actual.status)) {
      failures.push(`expected status ${allowed.join(" or ")}, got ${actual.status}`);
    }
  }

  if (expect.bodyContains !== undefined) {
    if (actual.bodyText === undefined || !actual.bodyText.includes(expect.bodyContains)) {
      failures.push(`expected body to contain "${expect.bodyContains}"`);
    }
  }

  if (expect.jsonPath !== undefined) {
    for (const [path, expected] of Object.entries(expect.jsonPath)) {
      try {
        const actualValue = extractJsonPath(actual.body, path);
        if (!deepEqual(actualValue, expected)) {
          // Redacted, because this message is quoted in failedExpectations, a
          // finding's summary, report.json/md, the fix prompt and the terminal
          // - all of which are meant to be safe to paste publicly.
          const extra = [...(options.extraSecretKeys ?? [])];
          failures.push(
            `expected ${path} to equal ${redactValueForMessage(expected, path, extra)}, got ${redactValueForMessage(actualValue, path, extra)}`
          );
        }
      } catch (err) {
        failures.push(err instanceof JsonPathError ? err.message : String(err));
      }
    }
  }

  return { passed: failures.length === 0, failures };
}
