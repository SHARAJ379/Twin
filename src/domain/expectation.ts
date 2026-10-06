import { extractJsonPath, JsonPathError } from "./jsonPath.js";
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

export function evaluateExpectation(expect: Expectation | undefined, actual: ActualResponse): ExpectationResult {
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
        if (JSON.stringify(actualValue) !== JSON.stringify(expected)) {
          failures.push(`expected ${path} to equal ${JSON.stringify(expected)}, got ${JSON.stringify(actualValue)}`);
        }
      } catch (err) {
        failures.push(err instanceof JsonPathError ? err.message : String(err));
      }
    }
  }

  return { passed: failures.length === 0, failures };
}
