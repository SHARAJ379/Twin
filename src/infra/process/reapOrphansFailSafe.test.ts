import { describe, expect, it, vi } from "vitest";

import { ConsoleLogger } from "../log/consoleLogger.js";
import { isProcessAlive } from "./isProcessAlive.js";
import type { PidRecord } from "./pidFile.js";

// In its own file so this mock can't leak into the tests that need the real
// lookup. getCommandLine is best-effort by design: it returns undefined when
// the OS won't answer (lookup timed out on a loaded machine, ps/PowerShell
// missing or restricted).
vi.mock("./getCommandLine.js", () => ({ getCommandLine: () => undefined }));

const { reapOrphans } = await import("./reapOrphans.js");

const logger = new ConsoleLogger({ level: "error" });

describe("reapOrphans fail-safe", () => {
  it("never kills a pid it cannot identify, even though the record claims it's ours", async () => {
    // This test runner's own pid, with a command that WOULD match the
    // fingerprint - so the only thing standing between it and killTree is the
    // refusal to act on an unverifiable process. If that regresses, this test
    // doesn't just fail, it kills its own worker.
    const records: PidRecord[] = [
      { pid: process.pid, instance: "A", command: process.execPath, startedAt: new Date().toISOString() }
    ];

    const result = await reapOrphans(records, logger);

    expect(result.skippedUnverifiable).toHaveLength(1);
    expect(result.reaped).toHaveLength(0);
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});
