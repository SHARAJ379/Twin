import { describe, expect, it } from "vitest";

import type { CheckInput } from "../domain/check.js";
import type { StepResult } from "../domain/stepResult.js";
import { dataConsistencyCheck } from "./dataConsistency.js";
import { builtInChecks } from "./index.js";
import { sessionSurvivesSwitchCheck } from "./sessionSurvivesSwitch.js";

function stepResult(overrides: Partial<StepResult>): StepResult {
  return { stepId: "s", startedAt: 0, durationMs: 1, expectationsPassed: true, failedExpectations: [], ...overrides };
}

const baseInput = (assertion: StepResult, control: StepResult): CheckInput => ({
  assertion,
  related: [],
  control,
  workspaceDiffs: [],
  profile: "ephemeral"
});

describe("built-in checks registry", () => {
  it("registers both checks under their scenario check: ids", () => {
    expect(builtInChecks.get("session-survives-switch")).toBe(sessionSurvivesSwitchCheck);
    expect(builtInChecks.get("data-consistency")).toBe(dataConsistencyCheck);
  });
});

describe("sessionSurvivesSwitchCheck", () => {
  it("fails when the cross-instance request was rejected but the control run's equivalent passed", () => {
    const finding = sessionSurvivesSwitchCheck.evaluate(
      baseInput(
        stepResult({ expectationsPassed: false, response: { status: 401, headers: {} }, failedExpectations: ["expected 200, got 401"] }),
        stepResult({ expectationsPassed: true })
      )
    );
    expect(finding.status).toBe("fail");
    expect(finding.summary).toMatch(/401/);
  });
});

describe("dataConsistencyCheck", () => {
  it("passes when the record is readable on the other instance", () => {
    const finding = dataConsistencyCheck.evaluate(baseInput(stepResult({ expectationsPassed: true }), stepResult({ expectationsPassed: true })));
    expect(finding.status).toBe("pass");
  });
});
