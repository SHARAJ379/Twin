import { describe, expect, it } from "vitest";

import type { Check, Finding } from "../domain/check.js";
import type { Scenario } from "../domain/scenario.js";
import type { StepResult } from "../domain/stepResult.js";
import { evaluate } from "./evaluate.js";

function stepResult(stepId: string, expectationsPassed: boolean): StepResult {
  return { stepId, startedAt: 0, durationMs: 1, expectationsPassed, failedExpectations: expectationsPassed ? [] : ["x"] };
}

const passthroughCheck: Check = {
  id: "data-consistency",
  title: "Data consistency",
  explanation: "test",
  evaluate(input): Finding {
    return input.assertion.expectationsPassed
      ? { checkId: "data-consistency", status: "pass", title: "Data consistency", summary: "ok", evidence: [], suspects: [] }
      : {
          checkId: "data-consistency",
          status: "fail",
          title: "Data consistency",
          summary: "bad",
          evidence: [],
          suspects: []
        };
  }
};

const scenario: Scenario = {
  version: 1,
  name: "s",
  steps: [
    { kind: "request", id: "create", request: { method: "POST", path: "/items" } },
    { kind: "request", id: "read-other", request: { method: "GET", path: "/items/1" }, check: "data-consistency" },
    { kind: "wait", id: "pause", ms: 5 }
  ]
};

describe("evaluate", () => {
  it("produces one Finding per tagged step, using the matching check from the registry", () => {
    const findings = evaluate({
      scenario,
      controlResults: [stepResult("create", true), stepResult("read-other", true)],
      splitResults: [stepResult("create", true), stepResult("read-other", false)],
      checks: new Map([["data-consistency", passthroughCheck]]),
      profile: "ephemeral"
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ checkId: "data-consistency", status: "fail" });
  });

  it("ignores steps with no `check:` tag and wait/restart steps entirely", () => {
    const findings = evaluate({
      scenario,
      controlResults: [],
      splitResults: [stepResult("create", true), stepResult("read-other", true), stepResult("pause", true)],
      checks: new Map([["data-consistency", passthroughCheck]]),
      profile: "ephemeral"
    });
    expect(findings).toHaveLength(1); // only read-other is tagged
  });

  it("reports an error Finding with a reason for an unknown check id", () => {
    const findings = evaluate({
      scenario,
      controlResults: [],
      splitResults: [stepResult("create", true), stepResult("read-other", true)],
      checks: new Map(), // empty registry
      profile: "ephemeral"
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.status).toBe("error");
    expect(findings[0]!.summary).toMatch(/unknown check id/i);
  });

  it("skips a tagged step the split run never reached", () => {
    const findings = evaluate({
      scenario,
      controlResults: [],
      splitResults: [stepResult("create", true)], // read-other missing
      checks: new Map([["data-consistency", passthroughCheck]]),
      profile: "ephemeral"
    });
    expect(findings).toHaveLength(0);
  });
});
