import { describe, expect, it } from "vitest";

import type { Finding } from "./check.js";
import { computeVerdict, verdictHeadline } from "./verdict.js";

function finding(status: Finding["status"]): Finding {
  const base = { checkId: "data-consistency" as const, title: "t", summary: "s", evidence: [], suspects: [] };
  return status === "error" || status === "skipped" ? { ...base, status, reason: "x" } : { ...base, status };
}

describe("computeVerdict", () => {
  it("is safe when everything passes", () => {
    const verdict = computeVerdict([finding("pass"), finding("pass")]);
    expect(verdict).toEqual({ passed: 2, failed: 0, errored: 0, skipped: 0, safeForMultiInstance: true });
  });

  it("is safe when some checks are skipped but nothing failed or errored", () => {
    const verdict = computeVerdict([finding("pass"), finding("skipped")]);
    expect(verdict.safeForMultiInstance).toBe(true);
  });

  it("is unsafe when anything fails", () => {
    const verdict = computeVerdict([finding("pass"), finding("fail")]);
    expect(verdict.safeForMultiInstance).toBe(false);
    expect(verdict.failed).toBe(1);
  });

  it("is unsafe when anything errors - an error is not a clean bill of health", () => {
    const verdict = computeVerdict([finding("pass"), finding("error")]);
    expect(verdict.safeForMultiInstance).toBe(false);
    expect(verdict.errored).toBe(1);
  });

  it("counts every status correctly across a mixed set", () => {
    const verdict = computeVerdict([finding("pass"), finding("pass"), finding("fail"), finding("error"), finding("skipped")]);
    expect(verdict).toEqual({ passed: 2, failed: 1, errored: 1, skipped: 1, safeForMultiInstance: false });
  });

  // Regression: a scenario with nothing tagged `check:` used to report
  // "looks safe to run on more than one instance" and exit 0, which is a
  // false green on any app whose scaffolded scenario didn't actually assert.
  it("is NOT safe when no checks ran at all - no evidence is not a pass", () => {
    const verdict = computeVerdict([]);
    expect(verdict.safeForMultiInstance).toBe(false);
    expect(verdictHeadline(verdict)).toBe("inconclusive");
  });

  it("is NOT safe when every check was skipped - still nothing verified", () => {
    const verdict = computeVerdict([finding("skipped"), finding("skipped")]);
    expect(verdict.safeForMultiInstance).toBe(false);
    expect(verdictHeadline(verdict)).toBe("inconclusive");
  });
});

describe("verdictHeadline", () => {
  it("is unsafe when a check failed, even alongside errors", () => {
    expect(verdictHeadline({ passed: 0, failed: 1, errored: 2, skipped: 0, safeForMultiInstance: false })).toBe("unsafe");
  });

  it("is inconclusive when something errored but nothing failed", () => {
    expect(verdictHeadline({ passed: 3, failed: 0, errored: 1, skipped: 0, safeForMultiInstance: false })).toBe("inconclusive");
  });

  it("is safe only when at least one check passed and nothing failed or errored", () => {
    expect(verdictHeadline({ passed: 1, failed: 0, errored: 0, skipped: 5, safeForMultiInstance: true })).toBe("safe");
  });
});
