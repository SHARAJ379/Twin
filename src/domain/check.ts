import type { CheckId } from "./scenario.js";
import type { StepResult } from "./stepResult.js";
import type { Suspect } from "./suspect.js";
import type { DeploymentProfile } from "./deploymentProfile.js";
import type { WorkspaceDiff } from "./workspaceDiff.js";

export type FindingStatus = "pass" | "fail" | "error" | "skipped";

/** A pointer into the evidence ledger, not a copy of it - the full StepResult lives in the run's results. */
export interface EvidenceRef {
  run: "control" | "split";
  stepId: string;
  note?: string | undefined;
}

interface FindingBase {
  checkId: CheckId;
  title: string;
  summary: string;
  evidence: EvidenceRef[];
  suspects: Suspect[];
}

export type Finding =
  | (FindingBase & { status: "pass" | "fail" })
  // `reason` is mandatory here, not just documented convention (§6.4): error/skipped
  // must always say *why* Twin couldn't judge, in the type itself.
  | (FindingBase & { status: "error" | "skipped"; reason: string });

export interface CheckInput {
  /** The step tagged `check: <id>` in the split run. */
  assertion: StepResult;
  related: StepResult[];
  /** The same step's result from the control run - a Finding can only be "fail" if this passed (I7). */
  control?: StepResult | undefined;
  workspaceDiffs: WorkspaceDiff[];
  profile: DeploymentProfile;
}

export interface Check {
  id: CheckId;
  title: string;
  /** Plain-English "why this matters", shown in reports. */
  explanation: string;
  evaluate(input: CheckInput): Finding;
}
