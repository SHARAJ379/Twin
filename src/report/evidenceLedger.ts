import type { StepResult } from "../domain/stepResult.js";

/**
 * Every Finding carries EvidenceRefs - `{ run: "split", stepId: "me-check" }`
 * - described in the architecture as pointers into the evidence ledger rather
 * than copies of it. The ledger itself was never written anywhere: the step
 * results lived in memory for the length of the run and went out with the
 * process, so a report pointed at evidence nobody could open, and the
 * redaction those results go through protected data that never left memory.
 *
 * This is that ledger, saved next to report.json as `results.json`.
 */
export interface EvidenceLedger {
  /** Follows semver like report.json's: additive changes only in a minor. */
  schemaVersion: 1;
  scenario: string;
  generatedAt: string;
  /** Keyed by the run a Finding's EvidenceRef names. */
  control: StepResult[];
  split: StepResult[];
}

export function buildEvidenceLedger(params: {
  scenarioName: string;
  controlResults: StepResult[];
  splitResults: StepResult[];
  generatedAt?: Date;
}): EvidenceLedger {
  return {
    schemaVersion: 1,
    scenario: params.scenarioName,
    generatedAt: (params.generatedAt ?? new Date()).toISOString(),
    control: params.controlResults,
    split: params.splitResults
  };
}
