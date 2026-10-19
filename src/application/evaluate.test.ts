import { describe, expect, it } from "vitest";

import type { Check, Finding } from "../domain/check.js";
import type { Scenario } from "../domain/scenario.js";
import type { StepResult } from "../domain/stepResult.js";
import { evaluate, INSTANCE_DIVERGENCE_CHECK_ID, SCENARIO_INTEGRITY_CHECK_ID } from "./evaluate.js";

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
      workspaceDiffs: [],
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
      workspaceDiffs: [],
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
      workspaceDiffs: [],
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
      workspaceDiffs: [],
      checks: new Map([["data-consistency", passthroughCheck]]),
      profile: "ephemeral"
    });
    expect(findings).toHaveLength(0);
  });

  // Regression: an untagged step failing its own `expect:` used to produce no
  // finding at all, so a scenario that never actually worked reported
  // "0 of 0 checks passed - looks safe" and exited 0.
  it("reports an error Finding when an untagged step fails its own expectation", () => {
    const findings = evaluate({
      scenario,
      controlResults: [stepResult("create", false), stepResult("read-other", true)],
      splitResults: [stepResult("create", false), stepResult("read-other", true)],
      workspaceDiffs: [],
      checks: new Map([["data-consistency", passthroughCheck]]),
      profile: "ephemeral"
    });

    expect(findings[0]).toMatchObject({ checkId: SCENARIO_INTEGRITY_CHECK_ID, status: "error" });
    expect(findings[0]!.summary).toContain("create");
    expect(findings[0]!.summary).toContain("control + split");
  });

  it("does not report a scenario-integrity error when every untagged step passed", () => {
    const findings = evaluate({
      scenario,
      controlResults: [stepResult("create", true), stepResult("read-other", true)],
      splitResults: [stepResult("create", true), stepResult("read-other", true), stepResult("pause", true)],
      workspaceDiffs: [],
      checks: new Map([["data-consistency", passthroughCheck]]),
      profile: "ephemeral"
    });
    expect(findings.every((f) => f.checkId !== SCENARIO_INTEGRITY_CHECK_ID)).toBe(true);
  });

  // Regression (found dogfooding a FastAPI app): a logout on B that A never
  // heard about failed only in SPLIT, and was reported as "fix the scenario".
  describe("an untagged step that passed on one instance but failed across two", () => {
    const flow: Scenario = {
      version: 1,
      name: "logout",
      steps: [
        { kind: "request", id: "login", request: { method: "POST", path: "/login" } },
        { kind: "request", id: "logout", request: { method: "POST", path: "/logout" } },
        { kind: "request", id: "token-rejected", request: { method: "GET", path: "/me" } },
        { kind: "request", id: "after", request: { method: "GET", path: "/me" } }
      ]
    };
    function answered(stepId: string, status: number, passed: boolean): StepResult {
      return {
        ...stepResult(stepId, passed),
        instanceServed: "A",
        response: { status, headers: {} },
        failedExpectations: passed ? [] : [`expected status 401, got ${status}`]
      };
    }
    const allPassed = flow.steps.map((step) => stepResult(step.id, true));

    it("is reported as a multi-instance bug, not a broken scenario", () => {
      const findings = evaluate({
        scenario: flow,
        controlResults: allPassed,
        splitResults: [stepResult("login", true), stepResult("logout", true), answered("token-rejected", 200, false), stepResult("after", true)],
        workspaceDiffs: [],
        checks: new Map(),
        profile: "ephemeral"
      });

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ checkId: INSTANCE_DIVERGENCE_CHECK_ID, status: "fail" });
      expect(findings[0]!.blockedBy).toBeUndefined();
      expect(findings[0]!.summary).toContain('step "token-rejected" passed on a single instance but failed across two');
      expect(findings[0]!.summary).toContain("served by instance A");
      expect(findings[0]!.evidence).toContainEqual({ run: "control", stepId: "token-rejected", note: "passed on a single instance" });
    });

    it("reports one bug for the first step to diverge, with the later failures as its consequences", () => {
      const findings = evaluate({
        scenario: flow,
        controlResults: allPassed,
        splitResults: [
          stepResult("login", true),
          stepResult("logout", true),
          answered("token-rejected", 200, false),
          answered("after", 500, false)
        ],
        workspaceDiffs: [],
        checks: new Map(),
        profile: "ephemeral"
      });

      expect(findings).toHaveLength(1);
      expect(findings[0]!.summary).toContain('"token-rejected"');
      expect(findings[0]!.summary).toContain("after then failed too");
    });

    it("attributes a 401/403 to the session rather than to the step's own subject", () => {
      const findings = evaluate({
        scenario: flow,
        controlResults: allPassed,
        splitResults: [stepResult("login", true), answered("logout", 401, false)],
        workspaceDiffs: [],
        checks: new Map(),
        profile: "ephemeral"
      });

      expect(findings[0]).toMatchObject({ checkId: INSTANCE_DIVERGENCE_CHECK_ID, status: "fail", blockedBy: "auth" });
    });

    it("stays a scenario error when the control run failed an untagged step too", () => {
      const findings = evaluate({
        scenario: flow,
        controlResults: [stepResult("login", false), ...allPassed.slice(1)],
        splitResults: [stepResult("login", true), stepResult("logout", true), answered("token-rejected", 200, false)],
        workspaceDiffs: [],
        checks: new Map(),
        profile: "ephemeral"
      });

      expect(findings[0]).toMatchObject({ checkId: SCENARIO_INTEGRITY_CHECK_ID, status: "error" });
    });

    it("stays a scenario error when the first failure got no answer (a timeout is not a bug)", () => {
      const findings = evaluate({
        scenario: flow,
        controlResults: allPassed,
        splitResults: [
          stepResult("login", true),
          { ...stepResult("logout", false), error: { message: "timed out after 30000ms" } },
          answered("token-rejected", 200, false)
        ],
        workspaceDiffs: [],
        checks: new Map(),
        profile: "ephemeral"
      });

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ checkId: SCENARIO_INTEGRITY_CHECK_ID, status: "error" });
    });
  });

  it("leaves a failing TAGGED step to its own check rather than double-reporting it", () => {
    const findings = evaluate({
      scenario,
      controlResults: [stepResult("create", true), stepResult("read-other", false)],
      splitResults: [stepResult("create", true), stepResult("read-other", false)],
      workspaceDiffs: [],
      checks: new Map([["data-consistency", passthroughCheck]]),
      profile: "ephemeral"
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.checkId).toBe("data-consistency");
  });
});
