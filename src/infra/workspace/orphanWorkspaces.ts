import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

/**
 * `twin-<run-id>` exactly as run.ts builds it, where the run id is
 * fsArtifactStore's `<iso-with-hyphens>-<8 hex>`. Deliberately this strict: the
 * same tmp directory holds Twin's own test fixtures (`twin-orphan-*`,
 * `twin-trace-*`) and anything else a user named `twin-something`, and a sweep
 * that deletes directories is the wrong place to be generous about matching.
 */
const WORKSPACE_DIR = /^twin-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[0-9a-f]{8}$/;

/**
 * A run that still owns its workspace must never have it deleted underneath
 * it. Twin's own timeouts are bounded in seconds (60s boot, 30s per request),
 * so an hour is far past any run still making progress - and a workspace has
 * to be stale by both measures below to be swept, never just one.
 */
export const WORKSPACE_GRACE_MS = 60 * 60 * 1000;

export interface OrphanWorkspace {
  dir: string;
  /** From the run id in the directory name - when the run that made it started. */
  startedAtMs: number;
  /** Last write anywhere at the top of the workspace: an in-flight run keeps touching it. */
  mtimeMs: number;
}

function startedAtFrom(name: string): number | undefined {
  const m = WORKSPACE_DIR.exec(name);
  if (m === null) return undefined;
  const [, year, month, day, hour, minute, second, ms] = m as unknown as string[];
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(ms));
}

/**
 * Finds the per-instance workspace roots left in the system tmp directory by
 * runs that never got to clean up after themselves - a crash, a SIGKILL, a
 * `--keep-workspaces` run, or a Windows rm that lost to a held directory
 * handle. `twin run` removes its own on the way out, so anything still here
 * past the grace window belongs to nobody.
 */
export async function findOrphanWorkspaces(tmpDir: string, nowMs: number): Promise<{
  stale: OrphanWorkspace[];
  recent: OrphanWorkspace[];
}> {
  let entries;
  try {
    entries = await readdir(tmpDir, { withFileTypes: true });
  } catch {
    return { stale: [], recent: [] }; // no tmp dir to read: nothing to sweep, never an error
  }

  const stale: OrphanWorkspace[] = [];
  const recent: OrphanWorkspace[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const startedAtMs = startedAtFrom(entry.name);
    if (startedAtMs === undefined) continue;

    const dir = path.join(tmpDir, entry.name);
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(dir)).mtimeMs;
    } catch {
      continue; // vanished between readdir and stat - already gone
    }

    const workspace = { dir, startedAtMs, mtimeMs };
    const staleByBoth = nowMs - startedAtMs > WORKSPACE_GRACE_MS && nowMs - mtimeMs > WORKSPACE_GRACE_MS;
    (staleByBoth ? stale : recent).push(workspace);
  }

  return { stale, recent };
}

/** Removes `workspaces`, returning the ones that actually went. A directory that resists is reported, never thrown. */
export async function removeOrphanWorkspaces(
  workspaces: OrphanWorkspace[]
): Promise<{ removed: string[]; failed: { dir: string; error: string }[] }> {
  const removed: string[] = [];
  const failed: { dir: string; error: string }[] = [];

  for (const workspace of workspaces) {
    try {
      // Same retries as FsWorkspaceManager.cleanup: a just-killed process can
      // hold a handle inside the tree for a few ms on Windows.
      await rm(workspace.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      removed.push(workspace.dir);
    } catch (err) {
      failed.push({ dir: workspace.dir, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { removed, failed };
}
