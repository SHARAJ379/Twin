import { isAuthRejection } from "../domain/authRejection.js";
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

/**
 * Reported when an untagged step passed on a single instance but failed its
 * own `expect:` across two. That is the control gate (I7) applied to a step
 * nobody tagged: the scenario is proven to work, so the difference is the
 * app's multi-instance behavior. It used to be reported as the scenario being
 * broken ("fix the scenario"), which sent people looking for a bug in their
 * test when the test had just found one in their app.
 */
export const INSTANCE_DIVERGENCE_CHECK_ID = "instance-divergence";

function untaggedStepIds(scenario: Scenario): Set<string> {
  return new Set(
    scenario.steps.filter((step) => step.kind === "request" && step.check === undefined).map((step) => step.id)
  );
}

/**
 * The first untagged step that failed only in the split run, when the control
 * run passed every untagged step and that step got an answer. A step with no
 * answer (a timeout, a refused connection) stays a scenario error: that says
 * nothing about what the app did, and a flaky request must never be reported
 * as a bug. Steps after the first are its consequences, not bugs of their own.
 */
function controlPassedEveryUntaggedStep(input: EvaluateInput): boolean {
  const untagged = untaggedStepIds(input.scenario);
  return input.controlResults.every((r) => !untagged.has(r.stepId) || r.expectationsPassed);
}

/** The untagged steps that failed in the split run, in scenario order. */
function splitOnlyFailures(input: EvaluateInput): StepResult[] {
  const untagged = untaggedStepIds(input.scenario);
  const order = stepOrder(input.scenario);
  return input.splitResults
    .filter((r) => untagged.has(r.stepId) && !r.expectationsPassed)
    .sort((a, b) => (order.get(a.stepId) ?? 0) - (order.get(b.stepId) ?? 0));
}

function stepOrder(scenario: Scenario): Map<string, number> {
  return new Map(scenario.steps.map((step, index) => [step.id, index] as const));
}

function instanceDivergenceFinding(input: EvaluateInput): Finding | undefined {
  if (!controlPassedEveryUntaggedStep(input)) return undefined;

  const diverged = splitOnlyFailures(input);
  const first = diverged[0];
  if (first?.response === undefined) return undefined;

  const control = input.controlResults.find((r) => r.stepId === first.stepId);
  if (control === undefined) return undefined;

  const later = diverged.slice(1).map((r) => r.stepId);
  const where = first.instanceServed !== undefined ? ` (served by instance ${first.instanceServed})` : "";
  const then = later.length > 0 ? `; ${later.join(", ")} then failed too` : "";

  return {
    checkId: INSTANCE_DIVERGENCE_CHECK_ID,
    status: "fail",
    title: "Same behavior on one instance and two",
    summary: `step "${first.stepId}" passed on a single instance but failed across two${where} - ${first.failedExpectations.join("; ")}${then}`,
    evidence: [
      { run: "control", stepId: control.stepId, note: "passed on a single instance" },
      { run: "split", stepId: first.stepId, note: first.failedExpectations.join("; ") },
      ...later.map((stepId) => ({ run: "split" as const, stepId, note: `failed after "${first.stepId}"` }))
    ],
    suspects: [],
    // A 401/403 never reached the step's handler: what diverged is the session.
    ...(isAuthRejection(first) ? { blockedBy: "auth" as const } : {})
  };
}

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

/**
 * Turns every tagged (`check:`) step's split-run result, paired with its
 * control-run counterpart, into a Finding - headed by one for the untagged
 * steps when they didn't run as written.
 */
export function evaluate(input: EvaluateInput): Finding[] {
  const findings: Finding[] = [];
  const controlById = new Map(input.controlResults.map((r) => [r.stepId, r] as const));
  let firstFailedCheckIndex: number | undefined;

  input.scenario.steps.forEach((step, index) => {
    const finding = evaluateTaggedStep(input, step, index, controlById);
    if (finding === undefined) return;
    findings.push(finding);
    if (finding.status === "fail") firstFailedCheckIndex ??= index;
  });

  // An untagged step that only failed after a check had already caught a bug
  // is that bug's consequence (an update to the record B never got), not a
  // second bug - and the scenario is proven sound, so not a scenario error
  // either. Reporting it as either inflated "1 bug" into two.
  const firstSplitOnly = splitOnlyFailures(input)[0];
  const consequenceOfFailedCheck =
    firstSplitOnly !== undefined &&
    firstFailedCheckIndex !== undefined &&
    controlPassedEveryUntaggedStep(input) &&
    (stepOrder(input.scenario).get(firstSplitOnly.stepId) ?? 0) > firstFailedCheckIndex;

  // First, so it reads as the headline: if the scenario itself didn't run as
  // written, everything below it is suspect.
  const integrity = consequenceOfFailedCheck ? undefined : (instanceDivergenceFinding(input) ?? scenarioIntegrityFinding(input));
  return integrity === undefined ? findings : [integrity, ...findings];
}

/** A tagged (`check:`) step's Finding, or undefined for any other step and for one the split run never reached. */
function evaluateTaggedStep(
  input: EvaluateInput,
  step: Scenario["steps"][number],
  index: number,
  controlById: ReadonlyMap<string, StepResult>
): Finding | undefined {
  if (step.kind !== "request" || step.check === undefined) return undefined;

  const assertion = input.splitResults.find((r) => r.stepId === step.id);
  if (assertion === undefined) return undefined; // the split run didn't reach this step - nothing to evaluate

  const check = input.checks.get(step.check);
  if (check === undefined) {
    return {
      checkId: step.check,
      status: "error",
      title: step.check,
      summary: `unknown check id "${step.check}"`,
      evidence: [],
      suspects: [],
      reason: `no built-in or plugin check is registered for "${step.check}"`
    };
  }

  if (assertion.error?.code === NOT_SENT) return blockedByDependency(input, index, assertion, check.title);

  return check.evaluate({
    assertion,
    related: resolveRelatedSteps(input.scenario, index, input.splitResults),
    restartedBetween: restartedSinceRelated(input.scenario, index, input.splitResults),
    history: historyBefore(input, index),
    control: controlById.get(step.id),
    workspaceDiffs: input.workspaceDiffs,
    profile: input.profile
  });
}
