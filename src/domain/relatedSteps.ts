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
