import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import { quoteForShell } from "../../domain/shellQuote.js";
import { ConsoleLogger } from "../log/consoleLogger.js";
import { isProcessAlive } from "./isProcessAlive.js";
import { killTree } from "./killTree.js";
import type { PidRecord } from "./pidFile.js";
import { reapOrphans } from "./reapOrphans.js";

const logger = new ConsoleLogger({ level: "error" });

function spawnLongRunning() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: "ignore"
  });
}

describe("reapOrphans", () => {
  it("kills a live process whose record is given", async () => {
    const child = spawnLongRunning();
    const pid = child.pid!;
    const records: PidRecord[] = [{ pid, instance: "A", command: process.execPath, startedAt: new Date().toISOString() }];

    const result = await reapOrphans(records, logger);

    expect(result.reaped).toHaveLength(1);
    expect(isProcessAlive(pid)).toBe(false);
  });

  // Twin starts a compiled Go app by its quoted path. The live command line
  // has no quotes in it when sh execs the program directly - so matching the
  // quoted first word left every such orphan running, as "pid reuse".
  it("kills a live process recorded under a quoted program path, as Twin starts a compiled app", async () => {
    const child = spawnLongRunning();
    const pid = child.pid!;
    const command = quoteForShell(process.execPath, process.platform);
    const records: PidRecord[] = [{ pid, instance: "A", command, startedAt: new Date().toISOString() }];

    const result = await reapOrphans(records, logger);

    expect(result.reaped).toHaveLength(1);
    expect(isProcessAlive(pid)).toBe(false);
  });

  it("reports an already-dead pid separately, without touching anything", async () => {
    const child = spawnLongRunning();
    const pid = child.pid!;
    await killTree(pid, { mode: "crash", graceMs: 0 });

    const records: PidRecord[] = [{ pid, instance: "A", command: process.execPath, startedAt: new Date().toISOString() }];
    const result = await reapOrphans(records, logger);

    expect(result.alreadyDead).toHaveLength(1);
    expect(result.reaped).toHaveLength(0);
  });

  it("never kills a live process whose command line no longer matches (PID reuse guard)", async () => {
    // Use THIS test runner's own pid with a command that can't possibly
    // match - if the guard failed, this call would kill the test process.
    const records: PidRecord[] = [
      { pid: process.pid, instance: "A", command: "definitely-not-the-real-command", startedAt: new Date().toISOString() }
    ];

    const result = await reapOrphans(records, logger);

    // Asserts the invariant that matters - it was skipped, not killed - rather
    // than which bucket it landed in. Which one depends on whether the OS
    // answered the command-line lookup at all, and that varies with platform
    // and machine load; both answers are "left it alone", which is the point.
    // reapOrphansFailSafe.test.ts pins the unverifiable branch deterministically.
    expect(result.reaped).toHaveLength(0);
    expect(result.skippedPidReuse.length + result.skippedUnverifiable.length).toBe(1);
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});
