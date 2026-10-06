import type { Scenario } from "../domain/scenario.js";
import type { StepResult } from "../domain/stepResult.js";
import type { InstanceDriver, InstanceHandle, StartSpec } from "../ports/instanceDriver.js";
import type { Proxy } from "../ports/proxy.js";
import type { ScenarioClient } from "../ports/scenarioClient.js";

export interface SplitRunSpec {
  sourceDir: string;
  link: string[];
  ignore: string[];
  start: StartSpec;
  /** v1: ["A", "B"]; a list so N>2 instances is additive later (§13). */
  instanceIds: string[];
}

export interface SplitRunResult {
  results: StepResult[];
}

/**
 * Boots every instance behind the real proxy and runs the whole scenario
 * against them (§3 SPLIT phase). Always torn down here before returning -
 * callers only ever see captured StepResults, never live handles.
 */
export async function runSplitPhase(
  scenario: Scenario,
  spec: SplitRunSpec,
  instanceDriver: InstanceDriver,
  proxy: Proxy,
  scenarioClient: ScenarioClient
): Promise<SplitRunResult> {
  const instances: InstanceHandle[] = [];
  for (const instance of spec.instanceIds) {
    const ws = await instanceDriver.prepare({ instance, sourceDir: spec.sourceDir, link: spec.link, ignore: spec.ignore });
    instances.push(await instanceDriver.start(ws, spec.start));
  }

  const started = await proxy.start(() => instances);
  try {
    const results = await scenarioClient.run(scenario, { proxyUrl: started.url, instanceDriver, instances });
    return { results };
  } finally {
    await proxy.stop();
    for (const handle of instances) {
      await instanceDriver.stop(handle, { graceMs: 5000 });
    }
  }
}
