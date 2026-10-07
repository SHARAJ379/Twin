import { describe, expect, it } from "vitest";

import { computeExitCode } from "./exitCode.js";

describe("computeExitCode", () => {
  it("is 0 when everything passed (skips allowed)", () => {
    expect(computeExitCode({ passed: 2, failed: 0, errored: 0, skipped: 1, safeForMultiInstance: true })).toBe(0);
  });

  it("is 1 when anything failed, even alongside errors", () => {
    expect(computeExitCode({ passed: 0, failed: 1, errored: 1, skipped: 0, safeForMultiInstance: false })).toBe(1);
  });

  it("is 2 when there's an error but no fail", () => {
    expect(computeExitCode({ passed: 1, failed: 0, errored: 1, skipped: 0, safeForMultiInstance: false })).toBe(2);
  });

  // Regression: this used to be 0, so CI went green on a scenario that
  // verified nothing at all.
  it("is 2 when no checks ran - Twin verified nothing, so it can't report success", () => {
    expect(computeExitCode({ passed: 0, failed: 0, errored: 0, skipped: 0, safeForMultiInstance: false })).toBe(2);
  });

  it("is 2 when every check was skipped", () => {
    expect(computeExitCode({ passed: 0, failed: 0, errored: 0, skipped: 3, safeForMultiInstance: false })).toBe(2);
  });
});
