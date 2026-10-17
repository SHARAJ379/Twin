import type { InstanceId } from "./instance.js";
import type { RunHistory } from "./responseDivergence.js";
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
  /**
   * What stopped the assertion short of its own subject, when something did.
   * "auth" means the response was a 401/403, so the request never reached the
   * record/file/session state the check is named after (domain/authRejection.ts) -
   * the tracer blames the session layer for these rather than the store the
   * request never got to.
   */
  blockedBy?: "auth" | undefined;
  /**
   * Why a check that passed doesn't count as proof (domain/sharedDisk.ts):
   * both instances wrote to a local file outside their own workspaces, which
   * they share only because Twin runs them on one machine. Always on an
   * "error" finding, so the verdict can't call the app safe.
   */
  unprovenBy?: "shared-local-disk" | undefined;
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
  /**
   * Instances a `restart` step restarted between the related write and this
   * assertion, in the split run - how restart-persistence knows the read-back
   * really landed on a restarted instance.
   */
  restartedBetween?: InstanceId[];
  /** Each run's steps before this assertion - what the scenario had established by then. */
  history?: RunHistory;
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
