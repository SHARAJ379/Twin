import { describe, expect, it } from "vitest";

import type { StepResult } from "../domain/stepResult.js";
import { buildEvidenceLedger } from "./evidenceLedger.js";

function result(stepId: string): StepResult {
  return { stepId, startedAt: 0, durationMs: 1, expectationsPassed: true, failedExpectations: [] };
}

describe("buildEvidenceLedger", () => {
  it("keeps the two runs separate, so a Finding's EvidenceRef resolves unambiguously", () => {
    const ledger = buildEvidenceLedger({
      scenarioName: "basic-user-flow",
      controlResults: [result("login")],
      splitResults: [result("login"), result("me-check")],
      generatedAt: new Date("2026-10-13T00:00:00.000Z")
    });

    expect(ledger).toEqual({
      schemaVersion: 1,
      scenario: "basic-user-flow",
      generatedAt: "2026-10-13T00:00:00.000Z",
      control: [result("login")],
      split: [result("login"), result("me-check")]
    });
    // An EvidenceRef is { run, stepId } - this is the lookup it implies.
    expect(ledger.split.find((r) => r.stepId === "me-check")).toBeDefined();
    expect(ledger.control.find((r) => r.stepId === "me-check")).toBeUndefined();
  });

  it("survives a run that produced no results at all", () => {
    const ledger = buildEvidenceLedger({ scenarioName: "s", controlResults: [], splitResults: [] });
    expect(ledger.control).toEqual([]);
    expect(ledger.split).toEqual([]);
  });
});
