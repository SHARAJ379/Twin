import type { InstanceId } from "./instance.js";
import type { RequestStep, Scenario, Step } from "./scenario.js";
import type { StepResult } from "./stepResult.js";

function isMutatingRequestStep(step: Step): step is RequestStep {
  return step.kind === "request" && step.request.method.toUpperCase() !== "GET";
}

/**
 * Resolves what a tagged assertion step depends on (§4/§7.1's `after`,
 * defaulting to the nearest preceding mutating request step - e.g. the
 * `create-item` POST that `read-item-other-instance` implicitly follows).
 */
export function resolveRelatedSteps(scenario: Scenario, assertionIndex: number, results: StepResult[]): StepResult[] {
  const step = scenario.steps[assertionIndex];
  if (step === undefined) return [];
  const resultById = new Map(results.map((r) => [r.stepId, r] as const));

  if (step.kind === "request" && step.after !== undefined && step.after.length > 0) {
    return step.after.map((id) => resultById.get(id)).filter((r): r is StepResult => r !== undefined);
  }

  for (let i = assertionIndex - 1; i >= 0; i--) {
    const candidate = scenario.steps[i];
    if (candidate !== undefined && isMutatingRequestStep(candidate)) {
      const result = resultById.get(candidate.id);
      return result === undefined ? [] : [result];
    }
  }

  return [];
}

/**
 * Instances successfully restarted after the assertion's related write (its
 * earliest one, with `after:`) and before the assertion itself.
 */
export function restartedSinceRelated(scenario: Scenario, assertionIndex: number, results: StepResult[]): InstanceId[] {
  const related = new Set(resolveRelatedSteps(scenario, assertionIndex, results).map((r) => r.stepId));
  const firstRelated = scenario.steps.findIndex((step) => related.has(step.id));
  const succeeded = new Set(results.filter((r) => r.expectationsPassed).map((r) => r.stepId));
  const instances: InstanceId[] = [];
  for (const step of scenario.steps.slice(firstRelated + 1, assertionIndex)) {
    if (step.kind === "restart" && succeeded.has(step.id)) instances.push(step.instance);
  }
  return instances;
}

const CROSS_INSTANCE_CHECKS = new Set(["data-consistency", "file-consistency", "session-survives-switch"]);

/**
 * Where a built-in check's assertion has to go for it to test anything, when
 * the scenario didn't say (`via:` left out). Round-robin made that a matter of
 * luck: one unrelated step in between and the read-back landed on the
 * instance that did the write, which passes on any app. An explicit `via:` -
 * including `via: any` - is the scenario's own choice and is left alone; the
 * check still refuses to call an unexercised step a pass.
 */
export function defaultRouteForCheck(
  scenario: Scenario,
  assertionIndex: number,
  results: StepResult[],
  instanceIds: InstanceId[]
): InstanceId | undefined {
  const step = scenario.steps[assertionIndex];
  if (step?.kind !== "request" || step.check === undefined || step.via !== undefined) return undefined;
  // One instance (the control run) has nowhere else to send it.
  if (instanceIds.length < 2) return undefined;

  if (step.check === "restart-persistence") {
    const restarted = restartedSinceRelated(scenario, assertionIndex, results);
    return restarted[restarted.length - 1];
  }
  if (!CROSS_INSTANCE_CHECKS.has(step.check)) return undefined;

  const writer = resolveRelatedSteps(scenario, assertionIndex, results)
    .map((r) => r.instanceServed)
    .filter((id): id is InstanceId => id !== undefined)
    .at(-1);
  if (writer === undefined) return undefined;
  return instanceIds.find((id) => id !== writer);
}

