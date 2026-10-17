import { spawnSync, type SpawnSyncReturns } from "node:child_process";

/**
 * Windows reads a command line through PowerShell's CIM, whose first query on
 * a machine can take well over ten seconds while WMI warms up - a fresh CI
 * runner hit exactly that, and a stale lock's holder came back "unknown". A
 * timed-out query is asked once more with room to finish; it's only ever
 * slow on that path.
 */
const WINDOWS_TIMEOUTS_MS = [10_000, 30_000];

function timedOut(result: SpawnSyncReturns<string>): boolean {
  return (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || result.signal !== null;
}

/**
 * Best-effort live command line for `pid`, or undefined if it can't be determined.
 *
 * Callers must treat undefined as "unknown", never as "not a match" - reapOrphans
 * refuses to kill a pid it can't identify. The timeout is generous because a
 * slow answer here costs a leaked process, where a wrong one costs someone
 * else's process.
 */
export function getCommandLine(pid: number): string | undefined {
  try {
    if (process.platform === "win32") {
      for (const timeout of WINDOWS_TIMEOUTS_MS) {
        const result = spawnSync(
          "powershell",
          ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
          { encoding: "utf8", windowsHide: true, timeout }
        );
        if (timedOut(result)) continue;
        const out = result.stdout?.trim();
        return out !== undefined && out.length > 0 ? out : undefined;
      }
      return undefined;
    }

    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 10_000 });
    const out = result.stdout?.trim();
    return out !== undefined && out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}
