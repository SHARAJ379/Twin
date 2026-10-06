import type { Scenario } from "../domain/scenario.js";
import { stepsWithoutRestarts } from "../domain/scenarioTransform.js";
import type { StepResult } from "../domain/stepResult.js";
import type { InstanceDriver, StartSpec, WorkspaceSpec } from "../ports/instanceDriver.js";
import type { ScenarioClient } from "../ports/scenarioClient.js";

export interface ControlRunSpec {
  sourceDir: string;
  link: string[];
  ignore: string[];
  start: StartSpec;
}

export interface ControlRunResult {
  results: StepResult[];
}

const CONTROL_INSTANCE_ID = "control";

/**
 * Boots ONE throwaway instance and runs the whole scenario against it alone
 * (§3 CONTROL phase, ADR #6): proves the scenario/app works on a single
 * instance before a split-run failure can be attributed to multi-instance
 * behavior (I7). Always torn down here, so it can't leak state into SPLIT.
 */
export async function runControlPhase(
  scenario: Scenario,
  spec: ControlRunSpec,
  instanceDriver: InstanceDriver,
  scenarioClient: ScenarioClient
): Promise<ControlRunResult> {
  const workspaceSpec: WorkspaceSpec = {
    instance: CONTROL_INSTANCE_ID,
    sourceDir: spec.sourceDir,
    link: spec.link,
    ignore: spec.ignore
  };
  const ws = await instanceDriver.prepare(workspaceSpec);
  const handle = await instanceDriver.start(ws, spec.start);

  try {
    const controlScenario = stepsWithoutRestarts(scenario);
    const results = await scenarioClient.run(controlScenario, {
      proxyUrl: handle.baseUrl,
      instanceDriver,
      instances: [handle]
    });
    return { results };
  } finally {
    await instanceDriver.stop(handle, { graceMs: 5000 });
  }
}
