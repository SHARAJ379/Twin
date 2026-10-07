import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TwinError } from "../../domain/errors.js";
import { diffSnapshots } from "../../domain/workspaceDiff.js";
import type { StartSpec, WorkspaceSpec } from "../../ports/instanceDriver.js";
import { ConsoleLogger } from "../log/consoleLogger.js";
import { FsWorkspaceManager } from "../workspace/fsWorkspaceManager.js";
import { isProcessAlive } from "./isProcessAlive.js";
import * as portAllocator from "./portAllocator.js";
import { ProcessInstanceDriver } from "./processInstanceDriver.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const brokenExpressDir = path.resolve(here, "../../../examples/broken-express");

const logger = new ConsoleLogger({ level: "error" });

async function fetchOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

describe("ProcessInstanceDriver (against examples/broken-express)", () => {
  let root: string;
  let driver: ProcessInstanceDriver;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "twin-pid-test-"));
    driver = new ProcessInstanceDriver(new FsWorkspaceManager(root), logger);
  });

  afterEach(async () => {
    // maxRetries/retryDelay: on Windows, a just-killed process can hold its
    // cwd's directory handle for a few ms after taskkill returns, so an
    // immediate recursive rm can see a transient EBUSY/ENOTEMPTY.
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const workspaceSpec = (instance: string): WorkspaceSpec => ({
    instance,
    sourceDir: brokenExpressDir,
    link: ["node_modules"],
    ignore: []
  });
  const startSpec: StartSpec = {
    command: "npm start",
    portEnv: "PORT",
    env: {},
    healthPath: "/health",
    bootTimeoutMs: 15_000
  };

  it("boots a real app, serves health, and stop() kills the whole process tree", async () => {
    const ws = await driver.prepare(workspaceSpec("A"));
    const handle = await driver.start(ws, startSpec);

    expect(handle.state).toBe("ready");
    expect(handle.pid).toBeDefined();
    await expect(fetchOk(`${handle.baseUrl}/health`)).resolves.toBe(true);

    await driver.stop(handle, { graceMs: 2000 });

    // `npm start` is a two-level tree (npm -> node); if we only killed the
    // top pid, the node server would still answer. It must not.
    expect(isProcessAlive(handle.pid!)).toBe(false);
    await expect(fetchOk(`${handle.baseUrl}/health`)).resolves.toBe(false);
  });

  it("restart(disk: fresh) respawns on a clean workspace and the old process is gone", async () => {
    const ws = await driver.prepare(workspaceSpec("A"));
    const first = await driver.start(ws, startSpec);
    await expect(fetchOk(`${first.baseUrl}/health`)).resolves.toBe(true);

    const second = await driver.restart(first, { mode: "graceful", disk: "fresh" });

    expect(second.pid).not.toBe(first.pid);
    expect(isProcessAlive(first.pid!)).toBe(false);
    await expect(fetchOk(`${second.baseUrl}/health`)).resolves.toBe(true);

    await driver.stop(second, { graceMs: 2000 });
  });

  it("throws E_BOOT_CRASH with a log tail when the start command exits immediately", async () => {
    const ws = await driver.prepare(workspaceSpec("A"));
    // Generous even under heavy concurrent load (the full suite runs many
    // processes at once): we're testing crash classification, not speed.
    const crashSpec: StartSpec = { ...startSpec, command: 'node -e "process.exit(1)"', bootTimeoutMs: 3000 };

    const err = await driver.start(ws, crashSpec).catch((e: unknown) => e);
    expect(TwinError.isTwinError(err)).toBe(true);
    expect((err as TwinError).code).toBe("E_BOOT_CRASH");
  });

  it("snapshot() reflects a file the instance writes into its own workspace", async () => {
    const ws = await driver.prepare(workspaceSpec("A"));
    const handle = await driver.start(ws, startSpec);

    const before = await driver.snapshot(handle);
    await writeFile(path.join(ws.dir, "uploads-test.txt"), "written while running");
    const after = await driver.snapshot(handle);

    const diff = diffSnapshots(before, after);
    expect(diff.added.map((e) => e.path)).toContain("uploads-test.txt");

    await driver.stop(handle, { graceMs: 2000 });
  });

  it("snapshot() for an instance that was never started returns an empty snapshot, not a throw", async () => {
    const snap = await driver.snapshot({ id: "ghost", baseUrl: "http://127.0.0.1:1", state: "down" });
    expect(snap).toEqual({ instance: "ghost", entries: [] });
  });

  it("runs the build command in the instance's workspace before start, and fails fast with E_BUILD_FAILED on a bad one", async () => {
    const ws = await driver.prepare(workspaceSpec("A"));
    const buildSpec: StartSpec = { ...startSpec, build: 'node -e "process.exit(1)"' };

    const err = await driver.start(ws, buildSpec).catch((e: unknown) => e);
    expect(TwinError.isTwinError(err)).toBe(true);
    expect((err as TwinError).code).toBe("E_BUILD_FAILED");
  });

  it("start() succeeds once a passing build has written into the instance's own workspace", async () => {
    const ws = await driver.prepare(workspaceSpec("A"));
    const buildSpec: StartSpec = {
      ...startSpec,
      build: `node -e "require('fs').writeFileSync('built.txt', 'ok')"`
    };

    const handle = await driver.start(ws, buildSpec);
    expect(handle.state).toBe("ready");
    await expect(readFile(path.join(ws.dir, "built.txt"), "utf8")).resolves.toBe("ok");

    await driver.stop(handle, { graceMs: 2000 });
  });

  it("classifies a stolen port as E_PORT_UNAVAILABLE instead of a generic boot failure", async () => {
    // Destroys every connection immediately: pollHealth's own fetch() calls also
    // land on this port while it's "stolen", and an unanswered connection would
    // otherwise dangle until blocker.close()'s callback never fires.
    const blocker = createServer((socket) => socket.destroy());
    const takenPort = await new Promise<number>((resolve) => {
      blocker.listen(0, "127.0.0.1", () => {
        const address = blocker.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
    // mockResolvedValue (not -Once): start() retries up to 3 times, and every
    // retry must land on the same stolen port for the classification to hold.
    const spy = vi.spyOn(portAllocator, "getFreePort").mockResolvedValue(takenPort);

    try {
      const ws = await driver.prepare(workspaceSpec("A"));
      // A plain Node http server that reports the real EADDRINUSE error, like any real app would.
      const conflictSpec: StartSpec = {
        ...startSpec,
        command: `node -e "require('http').createServer(()=>{}).listen(${takenPort}, '127.0.0.1')"`,
        bootTimeoutMs: 2000
      };

      const err = await driver.start(ws, conflictSpec).catch((e: unknown) => e);
      expect(TwinError.isTwinError(err)).toBe(true);
      expect((err as TwinError).code).toBe("E_PORT_UNAVAILABLE");
    } finally {
      spy.mockRestore();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
