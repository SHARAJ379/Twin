import { describe, expect, it } from "vitest";

import { TwinError } from "../domain/errors.js";
import type { Scenario } from "../domain/scenario.js";
import type { StepResult } from "../domain/stepResult.js";
import type { FsSnapshot } from "../domain/workspaceDiff.js";
import type {
  InstanceDriver,
  InstanceHandle,
  PreparedWorkspace,
  RestartOptions,
  StartSpec,
  StopOptions,
  WorkspaceSpec
} from "../ports/instanceDriver.js";
import type { RunContext, ScenarioClient } from "../ports/scenarioClient.js";
import { runControlPhase, type ControlRunSpec } from "./controlRun.js";

const scenario: Scenario = { name: "x", version: 1, steps: [] };
const startSpec: StartSpec = { command: "npm start", portEnv: "PORT", env: {}, healthPath: "/health", bootTimeoutMs: 1000 };
const spec: ControlRunSpec = { sourceDir: "/src", link: [], ignore: [], start: startSpec };

/** Boots instantly, records stop() calls, and optionally fails stop(). */
function fakeDriver(stopFails: boolean): { driver: InstanceDriver; stopped: string[] } {
  const stopped: string[] = [];
  const driver: InstanceDriver = {
    prepare: (s: WorkspaceSpec): Promise<PreparedWorkspace> => Promise.resolve({ instance: s.instance, dir: `/ws/${s.instance}` }),
    start: (ws: PreparedWorkspace): Promise<InstanceHandle> =>
      Promise.resolve({ id: ws.instance, baseUrl: `http://fake/${ws.instance}`, pid: 1, state: "ready" }),
    stop: (handle: InstanceHandle, _opts: StopOptions): Promise<void> => {
      stopped.push(handle.id);
      return stopFails ? Promise.reject(new Error("pid file write failed")) : Promise.resolve();
    },
    restart: (handle: InstanceHandle, _opts: RestartOptions): Promise<InstanceHandle> => Promise.resolve(handle),
    logs: () => ({ lines: () => [] }),
    snapshot: (handle: InstanceHandle): Promise<FsSnapshot> => Promise.resolve({ instance: handle.id, entries: [] })
  };
  return { driver, stopped };
}

function fakeClient(run: (s: Scenario, ctx: RunContext) => Promise<StepResult[]>): ScenarioClient {
  return { run };
}

describe("runControlPhase teardown", () => {
  it("reports the scenario's own failure, not the teardown's, when both fail", async () => {
    // stop() awaits persistPidFile(), which does disk I/O and can reject. A
    // bare finally would let that replace the real reason the run failed,
    // leaving the user to debug a pid-file write instead of their app.
    const { driver, stopped } = fakeDriver(true);
    const client = fakeClient(() => Promise.reject(new Error("the app returned 500")));

    await expect(runControlPhase(scenario, spec, driver, client)).rejects.toThrow("the app returned 500");
    expect(stopped).toEqual(["control"]);
  });

  it("surfaces a teardown failure when the scenario itself succeeded", async () => {
    const { driver } = fakeDriver(true);
    const client = fakeClient(() => Promise.resolve([]));

    // Reported as E_TEARDOWN_PARTIAL (as runSplitPhase does), with the
    // underlying failure kept as `cause` rather than discarded.
    const error = await runControlPhase(scenario, spec, driver, client).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TwinError);
    expect((error as TwinError).code).toBe("E_TEARDOWN_PARTIAL");
    expect((error as TwinError).cause).toMatchObject({ message: "pid file write failed" });
  });

  it("stops the instance and returns results on the happy path", async () => {
    const { driver, stopped } = fakeDriver(false);
    const results: StepResult[] = [
      { stepId: "s1", startedAt: 0, durationMs: 1, expectationsPassed: true, failedExpectations: [] }
    ];
    const client = fakeClient(() => Promise.resolve(results));

    await expect(runControlPhase(scenario, spec, driver, client)).resolves.toEqual({ results });
    expect(stopped).toEqual(["control"]);
  });
});
