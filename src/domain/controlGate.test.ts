import { describe, expect, it } from "vitest";

import type { CheckInput } from "./check.js";
import { evaluateControlGated } from "./controlGate.js";
import type { StepResult } from "./stepResult.js";

function stepResult(overrides: Partial<StepResult>): StepResult {
  return { stepId: "s1", startedAt: 0, durationMs: 1, expectationsPassed: true, failedExpectations: [], ...overrides };
}

const describeFailure = () => "it broke across instances";

describe("evaluateControlGated", () => {
  it("passes when both control and split assertions pass", () => {
    const input: CheckInput = {
      assertion: stepResult({ stepId: "split-1", expectationsPassed: true }),
      related: [],
      control: stepResult({ stepId: "control-1", expectationsPassed: true }),
      workspaceDiffs: [],
      profile: "ephemeral"
    };
    const finding = evaluateControlGated(input, "data-consistency", "Data consistency", describeFailure);
    expect(finding.status).toBe("pass");
  });

  it("fails only when control passed but split did not (the core trust mechanism, I7)", () => {
    const input: CheckInput = {
      assertion: stepResult({ stepId: "split-1", expectationsPassed: false, failedExpectations: ["expected 200, got 401"] }),
      related: [],
      control: stepResult({ stepId: "control-1", expectationsPassed: true }),
      workspaceDiffs: [],
      profile: "ephemeral"
    };
    const finding = evaluateControlGated(input, "data-consistency", "Data consistency", describeFailure);
    expect(finding.status).toBe("fail");
    expect(finding.evidence).toEqual([
      { run: "control", stepId: "control-1", note: "passed on a single instance" },
      { run: "split", stepId: "split-1", note: "expected 200, got 401" }
    ]);
  });

  it("never reports fail when the control run itself failed - that's error, not fail", () => {
    const input: CheckInput = {
      assertion: stepResult({ stepId: "split-1", expectationsPassed: false }),
      related: [],
      control: stepResult({ stepId: "control-1", expectationsPassed: false, failedExpectations: ["scenario typo"] }),
      workspaceDiffs: [],
      profile: "ephemeral"
    };
    const finding = evaluateControlGated(input, "data-consistency", "Data consistency", describeFailure);
    expect(finding.status).toBe("error");
    if (finding.status === "error" || finding.status === "skipped") {
      expect(finding.reason).toMatch(/control run failed/);
    }
  });

  it("reports error with a reason when there is no control evidence at all", () => {
    const input: CheckInput = {
      assertion: stepResult({ stepId: "split-1" }),
      related: [],
      control: undefined,
      workspaceDiffs: [],
      profile: "ephemeral"
    };
    const finding = evaluateControlGated(input, "data-consistency", "Data consistency", describeFailure);
    expect(finding.status).toBe("error");
    if (finding.status === "error" || finding.status === "skipped") {
      expect(finding.reason.length).toBeGreaterThan(0);
    }
  });
});
