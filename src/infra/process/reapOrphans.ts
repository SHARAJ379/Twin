import type { Logger } from "../../ports/logger.js";
import { getCommandLine } from "./getCommandLine.js";
import { isProcessAlive } from "./isProcessAlive.js";
import { killTree } from "./killTree.js";
import type { PidRecord } from "./pidFile.js";

export interface ReapResult {
  reaped: PidRecord[];
  alreadyDead: PidRecord[];
  /** Alive, but the live command line doesn't match - almost certainly a PID the OS reused for something else. */
  skippedPidReuse: PidRecord[];
}

function fingerprint(command: string): string {
  return command.trim().split(/\s+/)[0] ?? command;
}

/**
 * Kills every live, still-matching process in `records` (§7.3's orphan
 * protection). A record whose pid is alive but no longer looks like what we
 * spawned is left alone - that pid was reused by an unrelated process.
 */
export async function reapOrphans(records: PidRecord[], logger: Logger): Promise<ReapResult> {
  const result: ReapResult = { reaped: [], alreadyDead: [], skippedPidReuse: [] };

  for (const record of records) {
    if (!isProcessAlive(record.pid)) {
      result.alreadyDead.push(record);
      continue;
    }

    const liveCommand = getCommandLine(record.pid);
    if (liveCommand !== undefined && !liveCommand.includes(fingerprint(record.command))) {
      result.skippedPidReuse.push(record);
      logger.warn(`pid ${record.pid} is alive but no longer looks like instance ${record.instance}; leaving it alone`, {
        expected: record.command,
        found: liveCommand
      });
      continue;
    }

    await killTree(record.pid, { mode: "crash", graceMs: 0 });
    result.reaped.push(record);
  }

  return result;
}
