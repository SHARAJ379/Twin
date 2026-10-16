import { describe, expect, it } from "vitest";

import type { CheckInput } from "../domain/check.js";
import type { StepResult } from "../domain/stepResult.js";
import { dataConsistencyCheck } from "./dataConsistency.js";
import { fileConsistencyCheck } from "./fileConsistency.js";
import { builtInChecks } from "./index.js";
import { restartPersistenceCheck } from "./restartPersistence.js";
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
  it("registers all four checks under their scenario check: ids", () => {
    expect(builtInChecks.get("session-survives-switch")).toBe(sessionSurvivesSwitchCheck);
    expect(builtInChecks.get("data-consistency")).toBe(dataConsistencyCheck);
    expect(builtInChecks.get("file-consistency")).toBe(fileConsistencyCheck);
    expect(builtInChecks.get("restart-persistence")).toBe(restartPersistenceCheck);
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

describe("fileConsistencyCheck", () => {
  it("fails when the uploaded file 404s on the other instance but the control run found it", () => {
    const finding = fileConsistencyCheck.evaluate(
      baseInput(
        stepResult({ expectationsPassed: false, response: { status: 404, headers: {} } }),
        stepResult({ expectationsPassed: true })
      )
    );
    expect(finding.status).toBe("fail");
    expect(finding.summary).toMatch(/404/);
  });

  it("errors, not fails, when the control run itself never found the file (I7)", () => {
    const finding = fileConsistencyCheck.evaluate(
      baseInput(stepResult({ expectationsPassed: false }), stepResult({ expectationsPassed: false, failedExpectations: ["404"] }))
    );
    expect(finding.status).toBe("error");
  });
});

describe("restartPersistenceCheck", () => {
  it("fails when data is unreadable after a restart but was readable before it, per the control run", () => {
    const finding = restartPersistenceCheck.evaluate(
      baseInput(
        stepResult({ expectationsPassed: false, response: { status: 401, headers: {} } }),
        stepResult({ expectationsPassed: true })
      )
    );
    expect(finding.status).toBe("fail");
  });

  it("passes when data survives the restart", () => {
    const finding = restartPersistenceCheck.evaluate(
      baseInput(stepResult({ expectationsPassed: true }), stepResult({ expectationsPassed: true }))
    );
    expect(finding.status).toBe("pass");
  });
});

// Regression: a 404 and a 401 used to produce the same sentence - "a record
// created via one instance could not be read back" - but a 401 means no
// handler ran, so Twin never found out whether the record was there.
describe("a check whose request was refused on auth", () => {
  const refused = () =>
    baseInput(
      stepResult({
        expectationsPassed: false,
        response: { status: 401, headers: {} },
        failedExpectations: ["expected status 200, got 401"]
      }),
      stepResult({ expectationsPassed: true })
    );

  it("does not claim data-consistency's record was missing, and marks the finding auth-blocked", () => {
    const finding = dataConsistencyCheck.evaluate(refused());
    expect(finding.status).toBe("fail");
    expect(finding.blockedBy).toBe("auth");
    expect(finding.summary).toContain("the session is what diverged");
    expect(finding.summary).not.toMatch(/could not be read back/);
  });

  it("does not claim file-consistency's file was missing", () => {
    const finding = fileConsistencyCheck.evaluate(refused());
    expect(finding.blockedBy).toBe("auth");
    expect(finding.summary).not.toMatch(/could not be fetched back/);
  });

  it("does not claim restart-persistence's data was lost in the restart", () => {
    const finding = restartPersistenceCheck.evaluate(refused());
    expect(finding.blockedBy).toBe("auth");
    expect(finding.summary).not.toMatch(/could not be read back/);
  });

  it("still describes a real 404 as the missing record it is", () => {
    const finding = dataConsistencyCheck.evaluate(
      baseInput(
        stepResult({ expectationsPassed: false, response: { status: 404, headers: {} } }),
        stepResult({ expectationsPassed: true })
      )
    );
    expect(finding.blockedBy).toBeUndefined();
    expect(finding.summary).toMatch(/could not be read back/);
  });

  // 401 is this check's own subject, so it keeps its own plain wording - and
  // is not "blocked" short of anything.
  it("leaves the session check's own summary and attribution alone", () => {
    const finding = sessionSurvivesSwitchCheck.evaluate(refused());
    expect(finding.summary).toMatch(/was rejected \(status 401\)/);
    expect(finding.blockedBy).toBeUndefined();
  });
});
