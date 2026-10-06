import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import { isProcessAlive } from "./isProcessAlive.js";
import { killTree } from "./killTree.js";

function spawnLongRunning() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: "ignore"
  });
}

describe("killTree", () => {
  it("kills a running process (crash mode)", async () => {
    const child = spawnLongRunning();
    const pid = child.pid;
    expect(pid).toBeDefined();
    expect(isProcessAlive(pid!)).toBe(true);

    await killTree(pid!, { mode: "crash", graceMs: 0 });

    expect(isProcessAlive(pid!)).toBe(false);
  });

  it("kills a running process (graceful mode)", async () => {
    const child = spawnLongRunning();
    const pid = child.pid;
    expect(pid).toBeDefined();

    await killTree(pid!, { mode: "graceful", graceMs: 2000 });

    expect(isProcessAlive(pid!)).toBe(false);
  });

  it("is a no-op for an already-dead pid", async () => {
    const child = spawnLongRunning();
    const pid = child.pid!;
    await killTree(pid, { mode: "crash", graceMs: 0 });

    await expect(killTree(pid, { mode: "crash", graceMs: 0 })).resolves.toBeUndefined();
  });
});
