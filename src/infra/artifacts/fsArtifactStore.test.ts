import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TwinError } from "../../domain/errors.js";
import { FsArtifactStore } from "./fsArtifactStore.js";

describe("FsArtifactStore", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-test-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("creates a run directory and resolves artifact paths inside it", async () => {
    const store = new FsArtifactStore(projectDir);
    const run = await store.createRun();

    expect(run.dir.startsWith(path.join(projectDir, ".twin", "runs"))).toBe(true);
    expect(store.pathFor(run, "report.json")).toBe(path.join(run.dir, "report.json"));
  });

  // Regression: run ids were truncated to whole seconds, so two runs started
  // in the same second shared one artifact dir AND one temp workspace root -
  // and the first one's cleanup() deleted the second's workspace mid-run.
  it("gives two runs created in the same second distinct ids and directories", async () => {
    const store = new FsArtifactStore(projectDir);
    const runs = await Promise.all([store.createRun(), store.createRun(), store.createRun()]);

    const ids = new Set(runs.map((r) => r.id));
    expect(ids.size).toBe(3);
    expect(new Set(runs.map((r) => r.dir)).size).toBe(3);
  });

  it("keeps run ids lexically sortable in chronological order (pruneOldRuns depends on it)", async () => {
    const store = new FsArtifactStore(projectDir);
    const first = await store.createRun();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.createRun();

    expect([second.id, first.id].sort()).toEqual([first.id, second.id]);
  });

  it("writes a latest pointer file (no symlink, for Windows compatibility)", async () => {
    const store = new FsArtifactStore(projectDir);
    const run = await store.createRun();
    await store.writeLatestPointer(run);

    const contents = await readFile(path.join(projectDir, ".twin", "latest"), "utf8");
    expect(contents).toBe(run.id);
  });

  it("acquires and releases the lock", async () => {
    const store = new FsArtifactStore(projectDir);
    const lock = await store.acquireLock();
    await lock.release();

    // Lock released -> a second acquire must succeed immediately.
    const lock2 = await store.acquireLock();
    await lock2.release();
  });

  it("refuses to acquire a lock held by a live process", async () => {
    const store = new FsArtifactStore(projectDir);
    const lock = await store.acquireLock(); // held by our own (live) pid

    await expect(store.acquireLock()).rejects.toThrow(TwinError);

    await lock.release();
  });

  it("reclaims a lock left behind by a dead pid", async () => {
    const store = new FsArtifactStore(projectDir);
    const lockPath = path.join(projectDir, ".twin", "lock");
    await mkdir(path.join(projectDir, ".twin"), { recursive: true });
    // A pid that (almost certainly) does not exist.
    await writeFile(lockPath, JSON.stringify({ pid: 999_999, startedAt: "x", token: "stale" }), "utf8");

    const lock = await store.acquireLock();
    await lock.release();
  });

  it("prunes old runs, keeping only the most recent N", async () => {
    const runsDir = path.join(projectDir, ".twin", "runs");
    const ids = ["2026-01-01T00-00-00Z", "2026-01-02T00-00-00Z", "2026-01-03T00-00-00Z"];
    for (const id of ids) {
      await mkdir(path.join(runsDir, id), { recursive: true });
    }

    const store = new FsArtifactStore(projectDir);
    await store.pruneOldRuns(2);

    const remaining = await readdir(runsDir);
    expect(remaining.sort()).toEqual(ids.slice(1)); // oldest dropped, two most recent kept
  });
});
