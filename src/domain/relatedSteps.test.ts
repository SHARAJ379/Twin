import { describe, expect, it } from "vitest";

import { resolveRelatedSteps } from "./relatedSteps.js";
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
