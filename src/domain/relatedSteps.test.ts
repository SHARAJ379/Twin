import { describe, expect, it } from "vitest";

import { defaultRouteForCheck, resolveRelatedSteps, restartedSinceRelated } from "./relatedSteps.js";
import type { Scenario } from "./scenario.js";
import type { StepResult } from "./stepResult.js";

function stepResult(stepId: string): StepResult {
  return { stepId, startedAt: 0, durationMs: 1, expectationsPassed: true, failedExpectations: [] };
}

describe("resolveRelatedSteps", () => {
  it("uses an explicit `after` list when present", () => {
    const scenario: Scenario = {
      version: 1,
      name: "s",
      steps: [
        { kind: "request", id: "signup", request: { method: "POST", path: "/signup" } },
        { kind: "request", id: "login", request: { method: "POST", path: "/login" } },
        { kind: "request", id: "check", request: { method: "GET", path: "/me" }, after: ["signup", "login"] }
      ]
    };
    const results = [stepResult("signup"), stepResult("login"), stepResult("check")];
    const related = resolveRelatedSteps(scenario, 2, results);
    expect(related.map((r) => r.stepId)).toEqual(["signup", "login"]);
  });

  it("defaults to the nearest preceding mutating (non-GET) request step", () => {
    const scenario: Scenario = {
      version: 1,
      name: "s",
      steps: [
        { kind: "request", id: "create-item", request: { method: "POST", path: "/items" } },
        { kind: "request", id: "noise-get", request: { method: "GET", path: "/health" } },
        { kind: "request", id: "read-item", request: { method: "GET", path: "/items/1" } }
      ]
    };
    const results = [stepResult("create-item"), stepResult("noise-get"), stepResult("read-item")];
    const related = resolveRelatedSteps(scenario, 2, results);
    expect(related.map((r) => r.stepId)).toEqual(["create-item"]);
  });

  it("skips restart steps when looking for the nearest preceding mutation", () => {
    const scenario: Scenario = {
      version: 1,
      name: "s",
      steps: [
        { kind: "request", id: "create-item", request: { method: "POST", path: "/items" } },
        { kind: "restart", id: "restart-a", instance: "A" },
        { kind: "request", id: "read-item", request: { method: "GET", path: "/items/1" } }
      ]
    };
    const results = [stepResult("create-item"), stepResult("restart-a"), stepResult("read-item")];
    const related = resolveRelatedSteps(scenario, 2, results);
    expect(related.map((r) => r.stepId)).toEqual(["create-item"]);
  });

  it("returns an empty array when nothing precedes it", () => {
    const scenario: Scenario = {
      version: 1,
      name: "s",
      steps: [{ kind: "request", id: "only", request: { method: "GET", path: "/" } }]
    };
    expect(resolveRelatedSteps(scenario, 0, [stepResult("only")])).toEqual([]);
  });
});

describe("defaultRouteForCheck", () => {
  const served = (stepId: string, instance: string): StepResult => ({ ...stepResult(stepId), instanceServed: instance });

  /**
   * The audited case: create, one unrelated GET, read back - no `via:` at
   * all. Round-robin sent the read back to the instance that did the create,
   * and an in-memory app passed. The read has to go to the other one.
   */
  it("sends an unpinned cross-instance check to the instance the write didn't use", () => {
    const scenario: Scenario = {
      version: 1,
      name: "s",
      steps: [
        { kind: "request", id: "create", request: { method: "POST", path: "/items" } },
        { kind: "request", id: "noise", request: { method: "GET", path: "/health" } },
        { kind: "request", id: "read", request: { method: "GET", path: "/items/1" }, check: "data-consistency" }
      ]
    };
    const results = [served("create", "A"), served("noise", "B")];
    expect(defaultRouteForCheck(scenario, 2, results, ["A", "B"])).toBe("B");
    expect(defaultRouteForCheck(scenario, 2, [served("create", "B"), served("noise", "A")], ["A", "B"])).toBe("A");
  });

  it("sends an unpinned restart-persistence read to the instance that was restarted", () => {
    const scenario: Scenario = {
      version: 1,
      name: "s",
      steps: [
        { kind: "request", id: "create", request: { method: "POST", path: "/items" } },
        { kind: "restart", id: "restart-b", instance: "B" },
        { kind: "request", id: "read", request: { method: "GET", path: "/items/1" }, check: "restart-persistence" }
      ]
    };
    const results = [served("create", "A"), served("restart-b", "B")];
    expect(defaultRouteForCheck(scenario, 2, results, ["A", "B"])).toBe("B");
    expect(restartedSinceRelated(scenario, 2, results)).toEqual(["B"]);
  });

  it("leaves an explicit via (even `any`), an untagged step, and the single-instance control run alone", () => {
    const steps = (via?: "A" | "any"): Scenario => ({
      version: 1,
      name: "s",
      steps: [
        { kind: "request", id: "create", request: { method: "POST", path: "/items" } },
        { kind: "request", id: "read", request: { method: "GET", path: "/items/1" }, check: "data-consistency", ...(via ? { via } : {}) }
      ]
    });
    const results = [served("create", "A")];
    expect(defaultRouteForCheck(steps("A"), 1, results, ["A", "B"])).toBeUndefined();
    expect(defaultRouteForCheck(steps("any"), 1, results, ["A", "B"])).toBeUndefined();
    expect(defaultRouteForCheck(steps(), 1, results, ["A"])).toBeUndefined();
    const untagged: Scenario = { ...steps(), steps: steps().steps.map((step) => ({ ...step, check: undefined })) as Scenario["steps"] };
    expect(defaultRouteForCheck(untagged, 1, results, ["A", "B"])).toBeUndefined();
  });
});
