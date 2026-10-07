import type { Scenario } from "../domain/scenario.js";
import { TwinError } from "../domain/errors.js";
import type { StepResult } from "../domain/stepResult.js";
import { diffSnapshots, type WorkspaceDiff } from "../domain/workspaceDiff.js";
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
  /** One per instance, each instance's disk before vs. after the whole scenario ran (§7.5/§3 COLLECT). */
  workspaceDiffs: WorkspaceDiff[];
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

  const before = await Promise.all(instances.map((h) => instanceDriver.snapshot(h)));

  const started = await proxy.start(() => instances);
  let result: SplitRunResult | undefined;
  let primaryError: unknown;
  try {
    const results = await scenarioClient.run(scenario, { proxyUrl: started.url, instanceDriver, instances });

    // `instances` entries may have been replaced in place by a restart step
    // (the scenario client mutates the array) - snapshot whatever is
    // currently running under each original id, not the original handles.
    const after = await Promise.all(instances.map((h) => instanceDriver.snapshot(h)));
    const workspaceDiffs = before.map((b, i) => diffSnapshots(b, after[i]!));
    result = { results, workspaceDiffs };
  } catch (err) {
    primaryError = err;
  }

  // Best-effort: the proxy has no "instance" to report as leaked, and a
  // failure here must not mask the scenario's own result either.
  await proxy.stop().catch(() => undefined);
  // allSettled, not a sequential loop: one instance's stop() throwing must
  // never skip tearing down the rest (that would leak a live process).
  const teardowns = await Promise.allSettled(instances.map((handle) => instanceDriver.stop(handle, { graceMs: 5000 })));
  const failed = teardowns
    .map((outcome, i) => ({ outcome, instance: instances[i]! }))
    .filter((x): x is { outcome: PromiseRejectedResult; instance: InstanceHandle } => x.outcome.status === "rejected");

  // The scenario's own result always wins - a messy teardown doesn't change
  // whether the app passed, and must never hide why it failed.
  if (primaryError !== undefined) throw primaryError;

  if (failed.length > 0) {
    throw new TwinError(
      "E_TEARDOWN_PARTIAL",
      `${failed.length} of ${instances.length} instance(s) failed to shut down cleanly: ${failed.map((f) => f.instance.id).join(", ")}.`,
      {
        hint: "Run `twin clean` to reap any leftover processes.",
        details: { failedInstances: failed.map((f) => f.instance.id) },
        cause: failed[0]!.outcome.reason
      }
    );
  }

  return result!;
}
