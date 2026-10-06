import { readdir } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../../ports/logger.js";
import { readPidFile } from "../../infra/process/pidFile.js";
import { reapOrphans, type ReapResult } from "../../infra/process/reapOrphans.js";

/** Scans every `.twin/runs/<run-id>/pids.json` under `projectDir` and reaps anything still alive (§7.3). */
export async function cleanOrphans(projectDir: string, logger: Logger): Promise<ReapResult> {
  const runsDir = path.join(projectDir, ".twin", "runs");

  let runIds: string[];
  try {
    runIds = await readdir(runsDir);
  } catch {
    logger.info("nothing to clean up (no .twin/runs directory)");
    return { reaped: [], alreadyDead: [], skippedPidReuse: [] };
  }

  const allRecords = (
    await Promise.all(runIds.map((id) => readPidFile(path.join(runsDir, id, "pids.json"))))
  ).flat();

  const result = await reapOrphans(allRecords, logger);

  for (const record of result.reaped) {
    logger.info(`reaped orphaned process for instance ${record.instance}`, { pid: record.pid });
  }
  if (result.reaped.length === 0 && result.skippedPidReuse.length === 0) {
    logger.info("nothing to clean up");
  }

  return result;
}
