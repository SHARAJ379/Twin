import { spawnSync } from "node:child_process";

import { isProcessAlive } from "./isProcessAlive.js";

export interface KillTreeOptions {
  /** "graceful" sends SIGTERM and waits up to graceMs before SIGKILL. "crash" kills immediately. Ignored on Windows: taskkill /T /F is always a hard kill (§7.3). */
  mode: "graceful" | "crash";
  graceMs: number;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Kills `pid` and its entire descendant tree. Instances must be spawned with
 * `detached: true` on POSIX so they head their own process group (negative
 * pid signals the whole group); on Windows, `taskkill /T` walks the tree for us.
 */
export async function killTree(pid: number, options: KillTreeOptions): Promise<void> {
  if (!isProcessAlive(pid)) return;

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }

  if (options.mode === "crash") {
    safeKillGroup(pid, "SIGKILL");
    return;
  }

  safeKillGroup(pid, "SIGTERM");
  const deadline = Date.now() + options.graceMs;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await sleep(50);
  }
  if (isProcessAlive(pid)) {
    safeKillGroup(pid, "SIGKILL");
  }
}

function safeKillGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Group already gone, or (e.g. in a test) pid isn't a group leader - fall back to the single pid.
    try {
      process.kill(pid, signal);
    } catch {
      // Already dead.
    }
  }
}
