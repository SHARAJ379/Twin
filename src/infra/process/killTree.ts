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
  if (process.platform === "win32") {
    // taskkill /T walks the tree from a live parent, so a dead leader leaves
    // nothing to walk - Windows reparents orphans and there is no group to
    // signal. Nothing to do here.
    if (!isProcessAlive(pid)) return;
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }

  // Deliberately NOT short-circuiting on a dead leader. The leader is a
  // process-group leader (`detached: true`), and a group outlives it: a start
  // command like `npm start` or `sh -c "python app.py"` exits or dies while
  // the server it spawned keeps running and keeps the port. Returning early
  // because the leader was gone left exactly that server alive.
  //
  // The group id is the dead leader's pid, so there is a theoretical window
  // where the OS has recycled that pid onto an unrelated new group leader.
  // It's a far smaller risk than leaking the app under test: these pids are
  // seconds old and signalled immediately, while the alternative leaks a
  // process holding a port for as long as the machine is up.
  if (options.mode === "crash") {
    safeKillGroup(pid, "SIGKILL");
  } else {
    safeKillGroup(pid, "SIGTERM");
    const deadline = Date.now() + options.graceMs;
    while (Date.now() < deadline && isProcessAlive(pid)) {
      await sleep(50);
    }
    // Unconditional, where it used to be guarded by `isProcessAlive(pid)`:
    // with the leader already gone that guard was false, so a group whose
    // leader had exited got a SIGTERM and nothing else. SIGKILL to a group
    // that has fully drained is a no-op.
    safeKillGroup(pid, "SIGKILL");
  }

  // A signal being sent isn't the same as the OS having reaped the process -
  // that's asynchronous even for SIGKILL, and slow/loaded runners (macOS CI
  // in particular) can expose the gap. Callers rely on isProcessAlive(pid)
  // being accurate the instant this resolves, so confirm it before returning.
  const confirmDeadline = Date.now() + 2000;
  while (Date.now() < confirmDeadline && isProcessAlive(pid)) {
    await sleep(20);
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
