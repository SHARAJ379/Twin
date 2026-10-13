import { describe, expect, it, vi } from "vitest";

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
import type { Proxy } from "../ports/proxy.js";
import type { RunContext, ScenarioClient } from "../ports/scenarioClient.js";
import { runSplitPhase, type SplitRunSpec } from "./splitRun.js";

const scenario: Scenario = { name: "x", version: 1, steps: [] };
const startSpec: StartSpec = { command: "npm start", portEnv: "PORT", env: {}, healthPath: "/health", bootTimeoutMs: 1000 };

function fakeSpec(stopResults: Record<string, "ok" | "fail">): SplitRunSpec {
  return { sourceDir: "/src", link: [], ignore: [], start: startSpec, instanceIds: Object.keys(stopResults) };
}

/** Boots instantly, records every stop() call, and fails stop() for ids listed as "fail". */
function fakeDriver(stopResults: Record<string, "ok" | "fail">): { driver: InstanceDriver; stopped: string[] } {
  const stopped: string[] = [];
  const driver: InstanceDriver = {
    prepare: (spec: WorkspaceSpec): Promise<PreparedWorkspace> => Promise.resolve({ instance: spec.instance, dir: `/ws/${spec.instance}` }),
    start: (ws: PreparedWorkspace): Promise<InstanceHandle> =>
      Promise.resolve({ id: ws.instance, baseUrl: `http://fake/${ws.instance}`, pid: 1, state: "ready" }),
    stop: (handle: InstanceHandle, _opts: StopOptions): Promise<void> => {
      stopped.push(handle.id);
      return stopResults[handle.id] === "fail" ? Promise.reject(new Error(`stop failed for ${handle.id}`)) : Promise.resolve();
    },
    restart: (handle: InstanceHandle, _opts: RestartOptions): Promise<InstanceHandle> => Promise.resolve(handle),
    logs: () => ({ lines: () => [] }),
    snapshot: (handle: InstanceHandle): Promise<FsSnapshot> => Promise.resolve({ instance: handle.id, entries: [] })
  };
  return { driver, stopped };
}

function fakeProxy(overrides: Partial<Proxy> = {}): Proxy {
  return {
    start: () => Promise.resolve({ url: "http://fake-proxy" }),
    stop: () => Promise.resolve(),
    events: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ value: undefined, done: true as const }) }) }),
    ...overrides
  };
}

/** Boots instantly and records stops; `failOn` makes one driver call reject. */
function trackingDriver(failOn: { snapshot?: boolean } = {}): { driver: InstanceDriver; stopped: string[] } {
  const stopped: string[] = [];
  const driver: InstanceDriver = {
    prepare: (spec: WorkspaceSpec): Promise<PreparedWorkspace> =>
      Promise.resolve({ instance: spec.instance, dir: `/ws/${spec.instance}` }),
    start: (ws: PreparedWorkspace): Promise<InstanceHandle> =>
      Promise.resolve({ id: ws.instance, baseUrl: `http://fake/${ws.instance}`, pid: 1, state: "ready" }),
    stop: (handle: InstanceHandle, _opts: StopOptions): Promise<void> => {
      stopped.push(handle.id);
      return Promise.resolve();
    },
    restart: (handle: InstanceHandle, _opts: RestartOptions): Promise<InstanceHandle> => Promise.resolve(handle),
    logs: () => ({ lines: () => [] }),
    snapshot: (handle: InstanceHandle): Promise<FsSnapshot> =>
      failOn.snapshot === true
        ? Promise.reject(new Error("snapshot failed"))
        : Promise.resolve({ instance: handle.id, entries: [] })
  };
  return { driver, stopped };
}

function fakeClient(results: StepResult[] | (() => unknown)): ScenarioClient {
  return {
    run: (_scenario: Scenario, _ctx: RunContext): Promise<StepResult[]> =>
      typeof results === "function" ? Promise.reject(results()) : Promise.resolve(results)
  };
}

describe("runSplitPhase boot failures", () => {
  it("stops the instances that did boot when a later one fails to boot", async () => {
    const stopped: string[] = [];
    const driver: InstanceDriver = {
      prepare: (spec: WorkspaceSpec): Promise<PreparedWorkspace> =>
        Promise.resolve({ instance: spec.instance, dir: `/ws/${spec.instance}` }),
      start: (ws: PreparedWorkspace): Promise<InstanceHandle> =>
        ws.instance === "B"
          ? Promise.reject(new TwinError("E_BOOT_CRASH", "B crashed on boot"))
          : Promise.resolve({ id: ws.instance, baseUrl: `http://fake/${ws.instance}`, pid: 1, state: "ready" }),
      stop: (handle: InstanceHandle, _opts: StopOptions): Promise<void> => {
        stopped.push(handle.id);
        return Promise.resolve();
      },
      restart: (handle: InstanceHandle, _opts: RestartOptions): Promise<InstanceHandle> => Promise.resolve(handle),
      logs: () => ({ lines: () => [] }),
      snapshot: (handle: InstanceHandle): Promise<FsSnapshot> => Promise.resolve({ instance: handle.id, entries: [] })
    };

    const err = await runSplitPhase(scenario, fakeSpec({ A: "ok", B: "ok" }), driver, fakeProxy(), fakeClient([])).catch(
      (e: unknown) => e
    );

    // A used to be left running, holding its port, with nothing holding a handle to it.
    expect(stopped).toEqual(["A"]);
    expect(TwinError.isTwinError(err)).toBe(true);
    expect((err as TwinError).code).toBe("E_BOOT_CRASH");
  });

  it("surfaces the boot failure as-is when the first instance is the one that fails", async () => {
    const stopped: string[] = [];
    const driver: InstanceDriver = {
      prepare: (spec: WorkspaceSpec): Promise<PreparedWorkspace> =>
        Promise.resolve({ instance: spec.instance, dir: `/ws/${spec.instance}` }),
      start: (): Promise<InstanceHandle> => Promise.reject(new TwinError("E_BOOT_TIMEOUT", "never became healthy")),
      stop: (handle: InstanceHandle, _opts: StopOptions): Promise<void> => {
        stopped.push(handle.id);
        return Promise.resolve();
      },
      restart: (handle: InstanceHandle, _opts: RestartOptions): Promise<InstanceHandle> => Promise.resolve(handle),
      logs: () => ({ lines: () => [] }),
      snapshot: (handle: InstanceHandle): Promise<FsSnapshot> => Promise.resolve({ instance: handle.id, entries: [] })
    };

    const err = await runSplitPhase(scenario, fakeSpec({ A: "ok", B: "ok" }), driver, fakeProxy(), fakeClient([])).catch(
      (e: unknown) => e
    );

    expect(stopped).toEqual([]);
    expect((err as TwinError).code).toBe("E_BOOT_TIMEOUT");
  });
});

describe("runSplitPhase teardown on the stages between boot and scenario", () => {
  it("stops every instance when the proxy fails to bind its port", async () => {
    const { driver, stopped } = trackingDriver();
    const proxy = fakeProxy({
      start: () => Promise.reject(new TwinError("E_PORT_UNAVAILABLE", "something grabbed the port first"))
    });

    const err = await runSplitPhase(scenario, fakeSpec({ A: "ok", B: "ok" }), driver, proxy, fakeClient([])).catch(
      (e: unknown) => e
    );

    // Both had booted by then, and this stage used to sit outside every
    // teardown path - so they stayed up, holding their ports, with the caller
    // holding no handles to them.
    expect(stopped.sort()).toEqual(["A", "B"]);
    expect((err as TwinError).code).toBe("E_PORT_UNAVAILABLE");
  });

  it("stops every instance, and the proxy, when the before-snapshot fails", async () => {
    const { driver, stopped } = trackingDriver({ snapshot: true });
    let proxyStopped = false;
    const proxy = fakeProxy({
      stop: () => {
        proxyStopped = true;
        return Promise.resolve();
      }
    });

    const err = await runSplitPhase(scenario, fakeSpec({ A: "ok", B: "ok" }), driver, proxy, fakeClient([])).catch(
      (e: unknown) => e
    );

    expect(stopped.sort()).toEqual(["A", "B"]);
    expect(proxyStopped).toBe(true);
    expect((err as Error).message).toContain("snapshot failed");
  });
});

describe("runSplitPhase teardown", () => {
  it("tears down every instance and returns results when everything succeeds", async () => {
    const { driver, stopped } = fakeDriver({ A: "ok", B: "ok" });
    const result = await runSplitPhase(scenario, fakeSpec({ A: "ok", B: "ok" }), driver, fakeProxy(), fakeClient([]));

    expect(result.results).toEqual([]);
    expect(stopped.sort()).toEqual(["A", "B"]);
  });

  it("still stops every instance, and throws E_TEARDOWN_PARTIAL, when only one instance's stop() fails", async () => {
    const { driver, stopped } = fakeDriver({ A: "ok", B: "fail" });

    const err = await runSplitPhase(scenario, fakeSpec({ A: "ok", B: "fail" }), driver, fakeProxy(), fakeClient([])).catch(
      (e: unknown) => e
    );

    expect(stopped.sort()).toEqual(["A", "B"]); // A's stop() was still attempted, not skipped
    expect(TwinError.isTwinError(err)).toBe(true);
    expect((err as TwinError).code).toBe("E_TEARDOWN_PARTIAL");
    expect((err as TwinError).details?.failedInstances).toEqual(["B"]);
  });

  it("propagates the scenario's own failure, not E_TEARDOWN_PARTIAL, even if teardown also fails", async () => {
    const scenarioError = new Error("scenario blew up");
    const { driver } = fakeDriver({ A: "fail", B: "fail" });

    const err = await runSplitPhase(
      scenario,
      fakeSpec({ A: "fail", B: "fail" }),
      driver,
      fakeProxy(),
      fakeClient(() => scenarioError)
    ).catch((e: unknown) => e);

    expect(err).toBe(scenarioError);
  });

  it("does not let a failing proxy.stop() mask the scenario's result", async () => {
    const { driver } = fakeDriver({ A: "ok" });
    const proxy = fakeProxy();
    vi.spyOn(proxy, "stop").mockRejectedValue(new Error("proxy stop failed"));

    const result = await runSplitPhase(scenario, fakeSpec({ A: "ok" }), driver, proxy, fakeClient([]));
    expect(result.results).toEqual([]);
  });
});
