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
    const crashSpec: StartSpec = { ...startSpec, command: 'node -e "process.exit(1)"', bootTimeoutMs: 15_000 };

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

  // Regression: with `detached: true` on Windows the child's output is
  // uncapturable by every means (pipes, inherited fds, even the child shell's
  // own `> file`), so every boot failure there came back with an empty log
  // tail and no way to tell why the app died.
  it("captures the app's own output in the boot failure's log tail, on every platform", async () => {
    const ws = await driver.prepare(workspaceSpec("A"));
    const noisyCrash: StartSpec = {
      ...startSpec,
      command: `node -e "console.error('TWIN-TEST-MARKER: why it died'); process.exit(1)"`,
      bootTimeoutMs: 15_000
    };

    const err = await driver.start(ws, noisyCrash).catch((e: unknown) => e);

    expect(TwinError.isTwinError(err)).toBe(true);
    const logTail = (err as TwinError).details?.logTail as string[] | undefined;
    expect(logTail?.join("\n")).toContain("TWIN-TEST-MARKER: why it died");
  });

  it("also writes each instance's output to a log file when a log dir is configured", async () => {
    const logDir = path.join(root, "logs");
    const loggingDriver = new ProcessInstanceDriver(new FsWorkspaceManager(root), logger, undefined, logDir);
    const ws = await loggingDriver.prepare(workspaceSpec("A"));

    await loggingDriver
      .start(ws, { ...startSpec, command: `node -e "console.log('TO-FILE-MARKER'); process.exit(1)"`, bootTimeoutMs: 15_000 })
      .catch(() => undefined);

    await expect(readFile(path.join(logDir, "A.log"), "utf8")).resolves.toContain("TO-FILE-MARKER");
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
        // Room for a cold `node` start on a loaded machine: a boot timeout is
        // no longer retried, and the poll stops the moment the app dies, so
        // this only costs time when the crash really is slow.
        bootTimeoutMs: 15_000
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

/** Starts listening after 0.8s, like a real app that does some setup first. */
const SLOW_SERVER = `
const http = require("node:http");
setTimeout(() => {
  http.createServer((req, res) => res.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");
}, 800);
`;

/**
 * Hands the server to a process in its own session and exits 0 - what
 * `pm2 start` or a --daemon flag does. The server keeps this launcher's
 * stdout/stderr, so it holds Twin's pipes open, and records its pid so the
 * test can stop what Twin by design can't.
 */
const DAEMONIZING_LAUNCHER = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["s.js"], { detached: true, stdio: "inherit" });
fs.writeFileSync("escaped.pid", String(child.pid));
child.unref();
`;

/**
 * Hands the server off like DAEMONIZING_LAUNCHER, but with no stdio of ours -
 * as `pm2 start` does - so the only evidence left behind is the server that
 * binds Twin's port a moment later.
 */
const QUIET_LAUNCHER = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["s.js"], { detached: true, stdio: "ignore" });
fs.writeFileSync("escaped.pid", String(child.pid));
child.unref();
`;

/**
 * Reported by an external audit with \`--start "node s.js &"\`: Twin called a
 * server that was booting fine a crash ("exit code 0"), three times; skipped
 * killing the process group because its leader was "already dead"; dropped
 * the pid records; and then never exited, because the orphaned servers held
 * its stdout/stderr pipes - three servers left holding ports, and a CI job
 * hung until the runner's timeout.
 */
describe("ProcessInstanceDriver: start commands that background the server", () => {
  let root: string;
  let source: string;
  let driver: ProcessInstanceDriver;
  let pidFile: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "twin-bg-test-"));
    source = await mkdtemp(path.join(os.tmpdir(), "bg-source-"));
    pidFile = path.join(root, "pids.json");
    await writeFile(path.join(source, "s.js"), SLOW_SERVER, "utf8");
    await writeFile(path.join(source, "launch.js"), DAEMONIZING_LAUNCHER, "utf8");
    await writeFile(path.join(source, "launch-quiet.js"), QUIET_LAUNCHER, "utf8");
    await writeFile(path.join(source, "quit.js"), `console.log("nothing to serve");`, "utf8");
    driver = new ProcessInstanceDriver(new FsWorkspaceManager(root), logger, pidFile);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(source, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const spec = (command: string): StartSpec => ({ command, portEnv: "PORT", env: {}, healthPath: "/", bootTimeoutMs: 10_000 });

  it.skipIf(process.platform === "win32")("manages `node s.js &` as the instance it is: boots, serves, and stop() kills it", async () => {
    const ws = await driver.prepare({ instance: "A", sourceDir: source, link: [], ignore: [] });
    const handle = await driver.start(ws, spec("node s.js &"));
    await expect(fetchOk(handle.baseUrl)).resolves.toBe(true);

    await driver.stop(handle, { graceMs: 2000 });
    await expect(fetchOk(handle.baseUrl)).resolves.toBe(false);
  }, 30_000);

  it("refuses a start command that hands its server off, once, without hanging", async () => {
    const ws = await driver.prepare({ instance: "A", sourceDir: source, link: [], ignore: [] });
    const spawned = vi.spyOn(driver as unknown as { spawnOnce: () => Promise<unknown> }, "spawnOnce");

    const err = await driver.start(ws, spec("node launch.js")).catch((e: unknown) => e);
    try {
      expect(TwinError.isTwinError(err) && err.code).toBe("E_BOOT_DETACHED");
      expect((err as TwinError).hint).toContain("foreground");
      // Deterministic, so never retried: each retry used to leave another server behind.
      expect(spawned).toHaveBeenCalledTimes(1);
    } finally {
      const escaped = Number(await readFile(path.join(ws.dir, "escaped.pid"), "utf8").catch(() => "0"));
      if (escaped > 0 && isProcessAlive(escaped)) process.kill(escaped);
    }
  }, 30_000);

  it("calls it a hand-off when the server shows up on Twin's port, even holding none of its pipes", async () => {
    const ws = await driver.prepare({ instance: "A", sourceDir: source, link: [], ignore: [] });
    const spawned = vi.spyOn(driver as unknown as { spawnOnce: () => Promise<unknown> }, "spawnOnce");

    const err = await driver.start(ws, spec("node launch-quiet.js")).catch((e: unknown) => e);
    try {
      expect(TwinError.isTwinError(err) && err.code).toBe("E_BOOT_DETACHED");
      expect((err as TwinError).hint).toMatch(/running outside Twin - check port \d+/);
      expect(spawned).toHaveBeenCalledTimes(1);
    } finally {
      const escaped = Number(await readFile(path.join(ws.dir, "escaped.pid"), "utf8").catch(() => "0"));
      if (escaped > 0 && isProcessAlive(escaped)) process.kill(escaped);
    }
  }, 30_000);

  /**
   * Found by CI (macos-latest, Node 20): `npm start` printed "listening" and
   * then exited 0 with nothing left running - group gone, pipes closed, port
   * refused - and Twin reported a hand-off to a daemon, which it never
   * retries. Exit code 0 alone is no evidence anything escaped.
   */
  it("calls an exit 0 that leaves nothing behind a crash, and retries it", async () => {
    const ws = await driver.prepare({ instance: "A", sourceDir: source, link: [], ignore: [] });
    const spawned = vi.spyOn(driver as unknown as { spawnOnce: () => Promise<unknown> }, "spawnOnce");

    const err = await driver.start(ws, spec("node quit.js")).catch((e: unknown) => e);
    expect(TwinError.isTwinError(err) && err.code).toBe("E_BOOT_CRASH");
    expect((err as TwinError).message).toContain("exited (exit code 0) instead of serving");
    expect((err as TwinError).hint).toContain("pm2 start");
    expect(spawned).toHaveBeenCalledTimes(3);
  }, 60_000);
});

/**
 * Audit, third round: an app that ignores PORT and listens on a port of its
 * own stays alive and never answers, and Twin waited out the 60s boot
 * timeout three times - three minutes - before saying "did not become healthy".
 */
describe("ProcessInstanceDriver: an app listening on a port of its own", () => {
  let root: string;
  let source: string;
  let driver: ProcessInstanceDriver;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "twin-port-test-"));
    source = await mkdtemp(path.join(os.tmpdir(), "port-source-"));
    driver = new ProcessInstanceDriver(new FsWorkspaceManager(root), logger);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(source, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const spec: StartSpec = { command: "node s.js", portEnv: "PORT", env: {}, healthPath: "/", bootTimeoutMs: 3_000 };

  it("gives up after one timeout, and names the port the app's log says it took", async () => {
    const ownPort = await portAllocator.getFreePort();
    await writeFile(
      path.join(source, "s.js"),
      `require("node:http").createServer((_, res) => res.end("ok")).listen(${ownPort}, "127.0.0.1", () => console.log("Server listening on port ${ownPort}"));`,
      "utf8"
    );
    const ws = await driver.prepare({ instance: "A", sourceDir: source, link: [], ignore: [] });
    const spawned = vi.spyOn(driver as unknown as { spawnOnce: () => Promise<unknown> }, "spawnOnce");

    const started = Date.now();
    const err = await driver.start(ws, spec).catch((e: unknown) => e);
    expect(TwinError.isTwinError(err) && err.code).toBe("E_BOOT_TIMEOUT");
    expect((err as TwinError).message).toContain(`listening on port ${ownPort}`);
    expect((err as TwinError).hint).toContain("--port-env");
    expect(spawned).toHaveBeenCalledTimes(1);
    // Three attempts took at least three boot timeouts; one, plus a cold start
    // and teardown on a loaded machine, stays under that.
    expect(Date.now() - started).toBeLessThan(3 * spec.bootTimeoutMs);
  }, 30_000);

  it("says, when the app printed nothing before timing out, that it was probably still starting", async () => {
    await writeFile(path.join(source, "s.js"), `setTimeout(() => {}, 120000);`, "utf8");
    const ws = await driver.prepare({ instance: "A", sourceDir: source, link: [], ignore: [] });

    const err = await driver.start(ws, spec).catch((e: unknown) => e);
    expect(TwinError.isTwinError(err) && err.code).toBe("E_BOOT_TIMEOUT");
    expect((err as TwinError).hint).toContain("printed nothing at all");
    expect((err as TwinError).hint).toContain("--build");
  }, 30_000);

  it("still retries a crash on boot, which can come out differently", async () => {
    await writeFile(path.join(source, "s.js"), `process.exit(1);`, "utf8");
    const ws = await driver.prepare({ instance: "A", sourceDir: source, link: [], ignore: [] });
    const spawned = vi.spyOn(driver as unknown as { spawnOnce: () => Promise<unknown> }, "spawnOnce");

    const err = await driver.start(ws, spec).catch((e: unknown) => e);
    expect(TwinError.isTwinError(err) && err.code).toBe("E_BOOT_CRASH");
    expect(spawned).toHaveBeenCalledTimes(3);
  }, 30_000);
});
