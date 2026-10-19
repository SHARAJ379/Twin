import type { Logger } from "../../ports/logger.js";
import { getCommandLine } from "./getCommandLine.js";
import { isInstanceAlive, isProcessAlive } from "./isProcessAlive.js";
import { killTree } from "./killTree.js";
import { isSpawnedPid, type PidRecord } from "./pidFile.js";

export interface ReapResult {
  reaped: PidRecord[];
  alreadyDead: PidRecord[];
  /** Alive, but the live command line doesn't match - almost certainly a PID the OS reused for something else. */
  skippedPidReuse: PidRecord[];
  /**
   * Alive, but the OS wouldn't tell us what it is, so we can't confirm it's ours.
   * Left alone on purpose: see the fail-safe note on `reapOrphans`.
   */
  skippedUnverifiable: PidRecord[];
}

/**
 * What a live command line must contain to still be what Twin spawned: the
 * recorded command's program. One Twin quoted - a compiled app's path, which
 * can have spaces in it - is matched whole and without its quotes, because sh
 * can exec it in place of itself, and then the live command line has none.
 */
function fingerprint(command: string): string {
  const trimmed = command.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    if (end > 1) return trimmed.slice(1, end);
  }
  return trimmed.split(/\s+/)[0] ?? command;
}

/**
 * Kills every live, still-matching process in `records` (§7.3's orphan
 * protection). A record whose pid is alive but no longer looks like what we
 * spawned is left alone - that pid was reused by an unrelated process.
 *
 * Fail-safe on purpose: a pid is killed only when the OS positively confirms
 * it still looks like what Twin spawned. If the command line can't be read at
 * all (the lookup timed out on a loaded machine, `ps`/PowerShell is missing or
 * restricted), we do NOT kill it - pids get recycled fast, and the cost of
 * leaking a process you can kill yourself is nothing next to killing whatever
 * unrelated thing inherited that pid.
 */
export async function reapOrphans(records: PidRecord[], logger: Logger): Promise<ReapResult> {
  const result: ReapResult = { reaped: [], alreadyDead: [], skippedPidReuse: [], skippedUnverifiable: [] };

  for (const record of records) {
    // Before anything signals it: readPidFile already drops these, but a
    // record that names no real child, or this very process, must never
    // reach killTree whoever built the list.
    if (!isSpawnedPid(record.pid) || record.pid === process.pid || fingerprint(record.command).length === 0) {
      result.skippedUnverifiable.push(record);
      logger.warn(`pids.json names pid ${record.pid} for instance ${record.instance}, which Twin can't have started; leaving it alone`);
      continue;
    }

    if (!isProcessAlive(record.pid)) {
      // The leader is gone, but a backgrounded server it launched can still
      // be running in its process group. Signalling the group needs no
      // command-line check: a group id isn't recycled while it has members,
      // so `-pid` reaches what Twin spawned or nothing at all.
      if (isInstanceAlive(record.pid)) {
        await killTree(record.pid, { mode: "crash", graceMs: 0 });
        result.reaped.push(record);
      } else {
        result.alreadyDead.push(record);
      }
      continue;
    }

    const liveCommand = getCommandLine(record.pid);
    if (liveCommand === undefined) {
      result.skippedUnverifiable.push(record);
      logger.warn(
        `pid ${record.pid} is alive but the OS wouldn't say what it is, so Twin can't confirm it's instance ${record.instance}; leaving it alone`,
        { expected: record.command, hint: "if it really is a leftover instance, kill that pid yourself" }
      );
      continue;
    }

    if (!liveCommand.includes(fingerprint(record.command))) {
      result.skippedPidReuse.push(record);
      logger.warn(`pid ${record.pid} is alive but no longer looks like instance ${record.instance}; leaving it alone`, {
        expected: record.command,
        found: liveCommand
      });
      continue;
    }

    // verifiedOurs: the command-line match above is the confirmation that
    // this pid is still the process we recorded, which is what permits a
    // single-pid signal for an instance that heads no group.
    await killTree(record.pid, { mode: "crash", graceMs: 0, verifiedOurs: true });
    result.reaped.push(record);
  }

  return result;
}
