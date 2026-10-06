import type { Check, Finding } from "../domain/check.js";
import type { DeploymentProfile } from "../domain/deploymentProfile.js";
import { resolveRelatedSteps } from "../domain/relatedSteps.js";
import type { Scenario } from "../domain/scenario.js";
import type { StepResult } from "../domain/stepResult.js";
import type { WorkspaceDiff } from "../domain/workspaceDiff.js";

export interface EvaluateInput {
  scenario: Scenario;
  controlResults: StepResult[];
  splitResults: StepResult[];
  /** From the SPLIT run only - the control run is one throwaway instance, so there's nothing meaningful to diff against. */
  workspaceDiffs: WorkspaceDiff[];
  /** Injected by the composition root (cli/) - application never imports checks/ directly (layer rule). */
  checks: ReadonlyMap<string, Check>;
  profile: DeploymentProfile;
}

/** Turns every tagged (`check:`) step's split-run result, paired with its control-run counterpart, into a Finding. */
export function evaluate(input: EvaluateInput): Finding[] {
  const findings: Finding[] = [];
  const controlById = new Map(input.controlResults.map((r) => [r.stepId, r] as const));

  input.scenario.steps.forEach((step, index) => {
    if (step.kind !== "request" || step.check === undefined) return;

    const assertion = input.splitResults.find((r) => r.stepId === step.id);
    if (assertion === undefined) return; // the split run didn't reach this step - nothing to evaluate

    const check = input.checks.get(step.check);
    if (check === undefined) {
      findings.push({
        checkId: step.check,
        status: "error",
        title: step.check,
        summary: `unknown check id "${step.check}"`,
        evidence: [],
        suspects: [],
        reason: `no built-in or plugin check is registered for "${step.check}"`
      });
      return;
    }

    findings.push(
      check.evaluate({
        assertion,
        related: resolveRelatedSteps(input.scenario, index, input.splitResults),
        control: controlById.get(step.id),
        workspaceDiffs: input.workspaceDiffs,
        profile: input.profile
      })
    );
  });

  return findings;
}
