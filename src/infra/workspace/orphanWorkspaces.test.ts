import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findOrphanWorkspaces, removeOrphanWorkspaces, WORKSPACE_GRACE_MS } from "./orphanWorkspaces.js";

/** A workspace name exactly as run.ts builds it: `twin-` + fsArtifactStore's run id. */
function workspaceName(startedAt: Date, suffix = "dd36a688"): string {
  return `twin-${startedAt.toISOString().replace(/:/g, "-").replace(/\./g, "-")}-${suffix}`;
}

describe("findOrphanWorkspaces", () => {
  let tmpDir: string;
  const now = Date.UTC(2026, 9, 15, 12, 0, 0);

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "twin-sweep-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function makeDir(name: string, mtime: Date): Promise<string> {
    const dir = path.join(tmpDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "marker"), "x", "utf8");
    await utimes(dir, mtime, mtime);
    return dir;
  }

  it("finds a workspace whose run started and was last written well before the grace window", async () => {
    const old = new Date(now - 5 * WORKSPACE_GRACE_MS);
    const dir = await makeDir(workspaceName(old), old);

    const { stale, recent } = await findOrphanWorkspaces(tmpDir, now);

    expect(stale.map((w) => w.dir)).toEqual([dir]);
    expect(recent).toEqual([]);
  });

  it("leaves a recent workspace alone - a run in flight still owns it", async () => {
    const justNow = new Date(now - 1000);
    await makeDir(workspaceName(justNow), justNow);

    const { stale, recent } = await findOrphanWorkspaces(tmpDir, now);

    expect(stale).toEqual([]);
    expect(recent).toHaveLength(1);
  });

  // Both measures have to agree: a long run whose id is old but which is still
  // being written to is still somebody's.
  it("leaves an old run id alone while its workspace is still being written to", async () => {
    const old = new Date(now - 5 * WORKSPACE_GRACE_MS);
    await makeDir(workspaceName(old), new Date(now - 1000));

    const { stale, recent } = await findOrphanWorkspaces(tmpDir, now);

    expect(stale).toEqual([]);
    expect(recent).toHaveLength(1);
  });

  // The system tmp directory is shared - with Twin's own test fixtures, among
  // other things - and this sweep deletes directories recursively.
  it("ignores every directory that isn't exactly twin-<run-id>", async () => {
    const old = new Date(now - 5 * WORKSPACE_GRACE_MS);
    for (const name of [
      "twin-orphan-abc123", // tests/e2e/orphanCleanup.test.ts's own project dir
      "twin-trace-xyz", // tracer test fixtures
      "twin-fixed-shared-1", // the acceptance test's shared state dir
      "twin", // someone's unrelated folder
      "twin-2026-10-15T17-02-27-048Z", // run id with no random suffix
      "twin-2026-10-15T17-02-27-048Z-dd36a68", // 7 hex chars, not 8
      "twin-2026-10-15T17-02-27-048Z-ZZZZZZZZ", // not hex
      "twin-not-a-timestamp-dd36a688"
    ]) {
      await makeDir(name, old);
    }

    const { stale, recent } = await findOrphanWorkspaces(tmpDir, now);

    expect(stale).toEqual([]);
    expect(recent).toEqual([]);
  });

  it("returns nothing (never throws) when the tmp directory can't be read", async () => {
    const result = await findOrphanWorkspaces(path.join(tmpDir, "does-not-exist"), now);
    expect(result).toEqual({ stale: [], recent: [] });
  });

  it("removes the directory and its contents, reporting what went", async () => {
    const old = new Date(now - 5 * WORKSPACE_GRACE_MS);
    const dir = path.join(tmpDir, workspaceName(old));
    await mkdir(path.join(dir, "A", "nested"), { recursive: true });
    await writeFile(path.join(dir, "A", "nested", "data.json"), "{}", "utf8");
    // Last, or writing the contents would push the directory's mtime back to now.
    await utimes(dir, old, old);

    const { stale } = await findOrphanWorkspaces(tmpDir, now);
    const { removed, failed } = await removeOrphanWorkspaces(stale);

    expect(removed).toEqual([dir]);
    expect(failed).toEqual([]);
    const after = await findOrphanWorkspaces(tmpDir, now);
    expect(after.stale).toEqual([]);
  });
});
