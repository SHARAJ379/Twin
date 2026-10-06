import type { Scenario } from "./scenario.js";

/**
 * The control run ignores `via` naturally (there's only one instance to hit,
 * so a pin header is a no-op) but must not attempt a `restart` - there's
 * nothing to restart into a second instance of (§3: "all `via` ignored,
 * `restart` steps skipped").
 */
export function stepsWithoutRestarts(scenario: Scenario): Scenario {
  return { ...scenario, steps: scenario.steps.filter((step) => step.kind !== "restart") };
}
