import type { Check, Finding } from "../domain/check.js";
import type { DeploymentProfile } from "../domain/deploymentProfile.js";
import { resolveRelatedSteps, restartedSinceRelated } from "../domain/relatedSteps.js";
import type { RunHistory } from "../domain/responseDivergence.js";
import type { Scenario } from "../domain/scenario.js";
import { NOT_SENT, type StepResult } from "../domain/stepResult.js";
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

/**
 * Reported when a step fails its own `expect:` without being tied to a
 * `check:`. Nothing judges those steps otherwise, so the run would come back
 * silent - and a broken setup step makes every later step meaningless.
 */
export const SCENARIO_INTEGRITY_CHECK_ID = "scenario-ran-as-written";

function scenarioIntegrityFinding(input: EvaluateInput): Finding | undefined {
  const tagged = new Set(
    input.scenario.steps.filter((step) => step.kind === "request" && step.check !== undefined).map((step) => step.id)
  );

  const broken = new Map<string, { runs: string[]; failures: string[] }>();
  const collect = (run: "control" | "split", results: StepResult[]): void => {
    for (const result of results) {
      if (tagged.has(result.stepId) || result.expectationsPassed) continue;
      const existing = broken.get(result.stepId);
      if (existing === undefined) broken.set(result.stepId, { runs: [run], failures: result.failedExpectations });
      else existing.runs.push(run);
    }
  };
  collect("control", input.controlResults);
  collect("split", input.splitResults);

  if (broken.size === 0) return undefined;

  const detail = [...broken.entries()]
    .map(([stepId, { runs, failures }]) => `${stepId} [${runs.join(" + ")}] ${failures.join("; ")}`)
    .join(" | ");

  return {
    checkId: SCENARIO_INTEGRITY_CHECK_ID,
    status: "error",
    title: "Scenario ran as written",
    summary: `${broken.size} step(s) did not match their own \`expect:\` - ${detail}`,
    evidence: [...broken.entries()].map(([stepId, { runs }]) => ({
      run: runs[0] === "control" ? ("control" as const) : ("split" as const),
      stepId
    })),
    suspects: [],
    reason:
      "a step that fails its own expectation makes the rest of the scenario meaningless, so Twin can't judge multi-instance behavior from this run - fix the scenario (or the app) and re-run"
  };
}

/**
 * A check whose own request was never sent - a `{{var}}` an earlier step
 * should have saved, because that step failed. It tested nothing, so it can't
 * be a failure (or a pass): it is blocked, by the step that failed first. It
 * used to come out as "could not be read back (status no response)", a bug
 * of its own, when the one real bug was whatever broke the earlier step.
 */
function blockedByDependency(input: EvaluateInput, index: number, assertion: StepResult, title: string): Finding {
  const step = input.scenario.steps[index]!;
  const resultById = new Map(input.splitResults.map((r) => [r.stepId, r] as const));
  const earlier = input.scenario.steps.slice(0, index);
  const missing = assertion.error?.missingVariable;
  const saver =
    missing === undefined
      ? undefined
      : [...earlier].reverse().find((s) => s.kind === "request" && s.save !== undefined && missing in s.save);
  const failedFirst =
    (saver !== undefined && resultById.get(saver.id)?.expectationsPassed === false ? saver : undefined) ??
    earlier.find((s) => resultById.get(s.id)?.expectationsPassed === false);

  const dependency = failedFirst === undefined ? undefined : resultById.get(failedFirst.id);
  const how =
    dependency === undefined
      ? ""
      : dependency.response !== undefined
        ? ` (status ${dependency.response.status})`
        : dependency.error !== undefined
          ? ` (${dependency.error.message})`
          : "";
  const cause =
    failedFirst === undefined
      ? `${missing !== undefined ? `{{${missing}}} was never saved` : "it couldn't be built"}`
      : `step "${failedFirst.id}" failed first${how}${missing !== undefined ? ` and never saved {{${missing}}}` : ""}`;

  return {
    checkId: step.kind === "request" && step.check !== undefined ? step.check : title,
    status: "error",
    title,
    summary: `not tested: this check's request was never sent, because ${cause}`,
    evidence: [
      ...(failedFirst !== undefined ? [{ run: "split" as const, stepId: failedFirst.id, note: "failed first" }] : []),
      { run: "split", stepId: assertion.stepId, note: "never sent" }
    ],
    suspects: [],
    reason: `blocked by ${failedFirst !== undefined ? `step "${failedFirst.id}"` : "an earlier step"} - fix that and this check will run`,
    blockedBy: "dependency",
    ...(failedFirst !== undefined ? { blockedByStep: failedFirst.id } : {})
  };
}

/** Each run's results for the steps before `index` - the control run has no restart steps, so match by id. */
function historyBefore(input: EvaluateInput, index: number): RunHistory {
  const earlier = new Set(input.scenario.steps.slice(0, index).map((step) => step.id));
  return {
    control: input.controlResults.filter((r) => earlier.has(r.stepId)),
    split: input.splitResults.filter((r) => earlier.has(r.stepId))
  };
}

/** Turns every tagged (`check:`) step's split-run result, paired with its control-run counterpart, into a Finding. */
export function evaluate(input: EvaluateInput): Finding[] {
  const findings: Finding[] = [];

  // First, so it reads as the headline: if the scenario itself didn't run as
  // written, everything below it is suspect.
  const integrity = scenarioIntegrityFinding(input);
  if (integrity !== undefined) findings.push(integrity);
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

    if (assertion.error?.code === NOT_SENT) {
      findings.push(blockedByDependency(input, index, assertion, check.title));
      return;
    }

    findings.push(
      check.evaluate({
        assertion,
        related: resolveRelatedSteps(input.scenario, index, input.splitResults),
        restartedBetween: restartedSinceRelated(input.scenario, index, input.splitResults),
        history: historyBefore(input, index),
        control: controlById.get(step.id),
        workspaceDiffs: input.workspaceDiffs,
        profile: input.profile
      })
    );
  });

  return findings;
}
