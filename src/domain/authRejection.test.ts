import { describe, expect, it } from "vitest";

import { describeAuthRejectedFailure, isAuthRejection } from "./authRejection.js";
import type { StepResult } from "./stepResult.js";

function result(status?: number): StepResult {
  return {
    stepId: "s1",
    startedAt: 0,
    durationMs: 1,
    expectationsPassed: false,
    failedExpectations: [],
    ...(status === undefined ? {} : { response: { status, headers: {} } })
  };
}

describe("isAuthRejection", () => {
  it("is true for the statuses that mean the request never reached a handler", () => {
    expect(isAuthRejection(result(401))).toBe(true);
    expect(isAuthRejection(result(403))).toBe(true);
  });

  it("is false for a status the app answered with - including the 404 a genuinely missing record gives", () => {
    for (const status of [200, 404, 409, 500, 503]) {
      expect(isAuthRejection(result(status))).toBe(false);
    }
  });

  it("is false when there was no response at all (a timeout or connection error)", () => {
    expect(isAuthRejection(result())).toBe(false);
  });
});

describe("describeAuthRejectedFailure", () => {
  it("says what was refused and names the session as what diverged, not the store", () => {
    const summary = describeAuthRejectedFailure("the read-back via another instance", "any record", 401, "other-instance");
    expect(summary).toContain("rejected with status 401");
    expect(summary).toContain("the session is what diverged");
    // The claim it must never make: that the record itself was missing.
    expect(summary).not.toMatch(/could not be read back/);
  });

  it("does not blame a second instance for a refusal that happened on the same one", () => {
    // restart-persistence reads back `via` the instance it just restarted, so
    // the only instance in the request is the one that logged in. Saying it
    // "was refused on another" would name an instance that was never there.
    const summary = describeAuthRejectedFailure("the read-back after the restart", "any stored data", 401, "after-restart");
    expect(summary).toContain("after it restarted");
    expect(summary).not.toMatch(/refused on another/);
    expect(summary).toContain("the session is what diverged");
  });
});
