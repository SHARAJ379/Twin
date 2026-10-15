import { TwinError } from "../domain/errors.js";
import type { Scenario } from "../domain/scenario.js";
import { stepsWithoutRestarts } from "../domain/scenarioTransform.js";
import type { StepResult } from "../domain/stepResult.js";
import type { InstanceDriver, StartSpec, WorkspaceSpec } from "../ports/instanceDriver.js";
import type { ScenarioClient, ScenarioClientOptions } from "../ports/scenarioClient.js";

export interface ControlRunSpec {
  sourceDir: string;
  link: string[];
  ignore: string[];
  start: StartSpec;
  /** Forwarded verbatim to the scenario client's RunContext. */
  client?: ScenarioClientOptions;
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

  // Deliberately not a bare `finally`, for the same reason runSplitPhase isn't
  // one: stop() awaits a pid-file write, so it can reject on its own, and a
  // `finally` that rejects *replaces* the error it was running alongside. That
  // left the user debugging a pid-file write instead of the 500 their app
  // actually returned. The scenario's own result always wins.
  let results: StepResult[] | undefined;
  let primaryError: unknown;
  try {
    results = await scenarioClient.run(stepsWithoutRestarts(scenario), {
      proxyUrl: handle.baseUrl,
      instanceDriver,
      instances: [handle],
      ...spec.client
    });
  } catch (err) {
    primaryError = err;
  }

  let teardownError: unknown;
  try {
    await instanceDriver.stop(handle, { graceMs: 5000 });
  } catch (err) {
    teardownError = err;
  }

  if (primaryError !== undefined) throw primaryError;

  if (teardownError !== undefined) {
    throw new TwinError("E_TEARDOWN_PARTIAL", `The control instance failed to shut down cleanly.`, {
      hint: "Run `twin clean` to reap any leftover processes.",
      details: { failedInstances: [CONTROL_INSTANCE_ID] },
      cause: teardownError
    });
  }

  return { results: results! };
}
