import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { cleanOrphans } from "../../src/cli/commands/clean.js";
import { ConsoleLogger } from "../../src/infra/log/consoleLogger.js";
import { isProcessAlive } from "../../src/infra/process/isProcessAlive.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const brokenExpressDir = path.resolve(here, "../../examples/broken-express");
const helperScript = path.resolve(here, "./helpers/orphanManager.mjs");

const logger = new ConsoleLogger({ level: "error" });

/**
 * The orphan test required by TWIN_ARCHITECTURE.md §12/§16.2: kill the
 * managing process with SIGKILL mid-run, then `twin clean` must reap
 * everything it left behind.
 */
describe("orphan protection: twin clean reaps a process left behind by a killed manager", () => {
  let projectDir = "";

  afterEach(async () => {
    if (projectDir.length > 0) {
      await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("reaps the orphaned instance after the manager is SIGKILLed mid-run", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-orphan-"));
    const pidsFilePath = path.join(projectDir, ".twin", "runs", "run1", "pids.json");

    const manager = spawn(process.execPath, [helperScript, brokenExpressDir, pidsFilePath], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    const orphanPid = await new Promise<number>((resolve, reject) => {
      let out = "";
      manager.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        const match = /MANAGER_READY pid=(\d+)/.exec(out);
        if (match?.[1] !== undefined) resolve(Number(match[1]));
      });
      manager.once("error", reject);
      setTimeout(() => reject(new Error("manager never reported ready")), 10_000);
    });
    const managerPid = manager.pid;
    expect(managerPid).toBeDefined();

    expect(isProcessAlive(orphanPid)).toBe(true);
    expect(isProcessAlive(managerPid!)).toBe(true);

    // Give the app a real moment to finish booting before we pull the rug,
    // so a slow boot can't be mistaken for "died because the manager died".
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (!isProcessAlive(orphanPid)) {
      const childLog = await readFile(path.join(path.dirname(pidsFilePath), "child.log"), "utf8").catch(() => "<no log>");
      throw new Error(`orphan process died on its own before the manager was killed. child.log:\n${childLog}`);
    }

    // Simulate Twin crashing mid-run: the manager gets no chance to clean up after itself.
    process.kill(managerPid!, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 500));

    // The orphan survives its manager's death - that's the exact bug class being guarded against.
    if (!isProcessAlive(orphanPid)) {
      const childLog = await readFile(path.join(path.dirname(pidsFilePath), "child.log"), "utf8").catch(() => "<no log>");
      throw new Error(`orphan process died right after the manager was killed. child.log:\n${childLog}`);
    }

    const result = await cleanOrphans(projectDir, logger);

    expect(result.reaped.map((r) => r.pid)).toContain(orphanPid);
    expect(isProcessAlive(orphanPid)).toBe(false);
  }, 20_000);
});
