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

  /**
   * A process that leads no group stands in for the pid-reuse case: it's alive,
   * it's at the pid we were handed, and it is not ours. Liveness can't tell
   * those apart - a recycled pid is alive by definition - so only the caller's
   * own identity check may unlock the bare-pid signal.
   *
   * POSIX only: on Windows killTree goes through `taskkill /T`, which has no
   * group signal and no fallback to gate.
   */
  describe.skipIf(process.platform === "win32")("a pid that leads no process group", () => {
    /** No `detached`, so this child shares our group and `kill(-pid)` finds no such group. */
    function spawnNonLeader() {
      return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    }

    it("is left alone without the caller confirming identity", async () => {
      const child = spawnNonLeader();
      const pid = child.pid!;

      await killTree(pid, { mode: "crash", graceMs: 0 });

      expect(isProcessAlive(pid)).toBe(true);
      child.kill("SIGKILL");
    });

    it("is killed once the caller says it verified the pid is theirs", async () => {
      const child = spawnNonLeader();
      const pid = child.pid!;

      await killTree(pid, { mode: "crash", graceMs: 0, verifiedOurs: true });

      expect(isProcessAlive(pid)).toBe(false);
    });
  });
});
