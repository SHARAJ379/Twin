import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FsArtifactStore } from "../../infra/artifacts/fsArtifactStore.js";
import type { Logger } from "../../ports/logger.js";
import { readPidFile } from "../../infra/process/pidFile.js";
import { reapOrphans, type ReapResult } from "../../infra/process/reapOrphans.js";
import { findOrphanWorkspaces, removeOrphanWorkspaces } from "../../infra/workspace/orphanWorkspaces.js";

export interface CleanResult extends ReapResult {
  /** Temp workspace roots removed from the system tmp directory. */
  workspacesRemoved: string[];
  /** Workspaces left alone because they're too new to be sure nobody owns them. */
  workspacesKept: string[];
}

const EMPTY_REAP: ReapResult = { reaped: [], alreadyDead: [], skippedPidReuse: [], skippedUnverifiable: [] };

/** Reaps every live process recorded under `<projectDir>/.twin/runs/<run-id>/pids.json` (§7.3). */
async function reapRecordedProcesses(projectDir: string, logger: Logger): Promise<ReapResult | undefined> {
  const runsDir = path.join(projectDir, ".twin", "runs");

  let runIds: string[];
  try {
    runIds = await readdir(runsDir);
  } catch {
    return undefined; // no runs recorded for this project - the workspace sweep below still applies
  }

  const allRecords = (await Promise.all(runIds.map((id) => readPidFile(path.join(runsDir, id, "pids.json"))))).flat();
  const result = await reapOrphans(allRecords, logger);

  for (const record of result.reaped) {
    logger.info(`reaped orphaned process for instance ${record.instance}`, { pid: record.pid });
  }
  return result;
}

/**
 * `twin clean`: the two kinds of litter a run can leave behind when it doesn't
 * get to finish - instance processes (§7.3) and the tmp workspaces those
 * instances ran in (§7.5). The workspaces are swept even when this project has
 * no `.twin/runs` at all, which is the usual way they get stranded: the run
 * directory was deleted (or the run was started elsewhere) while the workspace
 * outlived it in the system tmp directory.
 */
export async function cleanOrphans(
  projectDir: string,
  logger: Logger,
  /** Overridable so tests can sweep a directory of their own instead of the machine's real one. */
  tmpDir: string = os.tmpdir()
): Promise<CleanResult> {
  const reaped = await reapRecordedProcesses(projectDir, logger);
  if (reaped === undefined) logger.info("no run history for this project (no .twin/runs directory)");

  // The lock's own error points here, so this has to be able to clear it: a
  // run that was killed leaves its lock behind, and "nothing to clean up"
  // with the lock still in place left deleting it by hand as the only way out.
  const lock = await new FsArtifactStore(projectDir).clearStaleLock();
  if (lock.cleared) logger.info("removed a lock left behind by a run that is no longer running");
  if (lock.holder !== undefined) {
    logger.warn(`a Twin run (pid ${lock.holder.pid}) is still in progress and holds the lock; leaving it`, {
      startedAt: lock.holder.startedAt
    });
  }

  // Processes first: a workspace can't be removed on Windows while an instance
  // still has its cwd inside it.
  const { stale, recent } = await findOrphanWorkspaces(tmpDir, Date.now());
  const { removed, failed } = await removeOrphanWorkspaces(stale);

  for (const { dir, error } of failed) {
    logger.warn("could not remove a leftover workspace", { dir, error, hint: "delete it yourself, or re-run `twin clean`" });
  }
  if (removed.length > 0) {
    logger.info(`removed ${removed.length} leftover workspace(s) from ${tmpDir}`);
  }
  if (recent.length > 0) {
    logger.info(`left ${recent.length} recent workspace(s) alone - too new to be sure no run still owns them`);
  }

  const result: CleanResult = {
    ...(reaped ?? EMPTY_REAP),
    workspacesRemoved: removed,
    workspacesKept: recent.map((w) => w.dir)
  };

  if (
    result.reaped.length === 0 &&
    result.skippedPidReuse.length === 0 &&
    result.skippedUnverifiable.length === 0 &&
    removed.length === 0 &&
    !lock.cleared
  ) {
    logger.info("nothing to clean up");
  }

  return result;
}
