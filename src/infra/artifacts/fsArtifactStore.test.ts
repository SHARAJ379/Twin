import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TwinError } from "../../domain/errors.js";
import type { Lock } from "../../ports/artifactStore.js";
import { FsArtifactStore } from "./fsArtifactStore.js";

// Lets a test play an OS that won't reveal a process's command line.
const commandLine = vi.hoisted(() => ({ unreadable: false }));
vi.mock("../process/getCommandLine.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../process/getCommandLine.js")>();
  return { getCommandLine: (pid: number) => (commandLine.unreadable ? undefined : original.getCommandLine(pid)) };
});

const STALE = JSON.stringify({ pid: 999_999, startedAt: "x", token: "stale" });

async function lockFiles(projectDir: string): Promise<string[]> {
  return (await readdir(path.join(projectDir, ".twin"))).filter((name) => name.startsWith("lock"));
}

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

  /**
   * The lock used to read the path and then write it, so two runs starting at
   * the same moment both saw no lock and both took it - sharing one `.twin/`
   * and racing on pids.json and the run directory. The exclusive create is
   * what makes exactly one of them win.
   */
  it("lets exactly one of two simultaneous acquires win", async () => {
    const store = new FsArtifactStore(projectDir);

    const outcomes = await Promise.allSettled([store.acquireLock(), store.acquireLock(), store.acquireLock()]);
    const won = outcomes.filter((o) => o.status === "fulfilled");
    const lost = outcomes.filter((o) => o.status === "rejected");

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(2);
    for (const outcome of lost) {
      expect(TwinError.isTwinError((outcome as PromiseRejectedResult).reason)).toBe(true);
      expect(((outcome as PromiseRejectedResult).reason as TwinError).code).toBe("E_LOCKED");
    }

    await (won[0] as PromiseFulfilledResult<{ release: () => Promise<void> }>).value.release();
    // and the lock is genuinely free again afterwards
    await (await store.acquireLock()).release();
  });

  /**
   * The reclaim path's own race, which survived the first two attempts at this
   * lock. Several runs all see the same stale lock, all judge it reclaimable,
   * and then delete in turn - so a later delete lands on the fresh lock an
   * earlier run has already taken, and both hold it. Reclaiming has to be an
   * atomic steal, not a check followed by a delete.
   */
  it("lets exactly one of several runs reclaim the same stale lock", async () => {
    const store = new FsArtifactStore(projectDir);
    await mkdir(path.join(projectDir, ".twin"), { recursive: true });
    await writeFile(path.join(projectDir, ".twin", "lock.1"), STALE, "utf8");

    const outcomes = await Promise.allSettled([store.acquireLock(), store.acquireLock(), store.acquireLock()]);
    const won = outcomes.filter((o) => o.status === "fulfilled");

    expect(won).toHaveLength(1);
    // and the one that won really is the lock on disk, with the stale one pruned
    expect(await lockFiles(projectDir)).toEqual(["lock.2"]);
    const onDisk = JSON.parse(await readFile(path.join(projectDir, ".twin", "lock.2"), "utf8")) as { pid: number };
    expect(onDisk.pid).toBe(process.pid);

    await (won[0] as PromiseFulfilledResult<{ release: () => Promise<void> }>).value.release();
  });

  /**
   * The rename-based steal's race, reproduced exactly as reported. P reads the
   * stale lock and judges it stale; Q then does a whole acquire; P resumes.
   * The rename moved Q's fresh lock away - it renamed whatever was at the path
   * by then - and both P and Q went on to believe they held the lock.
   */
  it("does not let a run that judged a lock stale take it from a run that has since acquired it", async () => {
    await mkdir(path.join(projectDir, ".twin"), { recursive: true });
    await writeFile(path.join(projectDir, ".twin", "lock.1"), STALE, "utf8");

    const p = new FsArtifactStore(projectDir);
    const q = new FsArtifactStore(projectDir);
    let qLock: Lock | undefined;

    // P's first look at the lock sees it stale, then stalls while Q acquires.
    type Internals = { readTopLock: () => Promise<unknown> };
    const pInternals = p as unknown as Internals;
    const realRead = pInternals.readTopLock.bind(p);
    vi.spyOn(pInternals, "readTopLock").mockImplementationOnce(async () => {
      const staleView = await realRead();
      qLock = await q.acquireLock();
      return staleView;
    });

    await expect(p.acquireLock()).rejects.toMatchObject({ code: "E_LOCKED" });
    expect(qLock).toBeDefined();
    // Q's lock is still the lock.
    expect(await lockFiles(projectDir)).toEqual(["lock.2"]);

    await qLock!.release();
    await (await p.acquireLock()).release();
  });

  it("treats an unreadable lock as mid-write while it is young, and as abandoned once it is old", async () => {
    const lockPath = path.join(projectDir, ".twin", "lock.1");
    await mkdir(path.join(projectDir, ".twin"), { recursive: true });
    await writeFile(lockPath, "", "utf8");

    const store = new FsArtifactStore(projectDir);
    await expect(store.acquireLock()).rejects.toMatchObject({ code: "E_LOCKED" });

    const longAgo = new Date(Date.now() - 60_000);
    await utimes(lockPath, longAgo, longAgo);
    await (await store.acquireLock()).release();
  });

  it("leaves only the released tombstone behind, and no temp files", async () => {
    const store = new FsArtifactStore(projectDir);
    await (await store.acquireLock()).release();
    await (await store.acquireLock()).release();

    expect(await lockFiles(projectDir)).toEqual(["lock.4"]);
  });

  it("reclaims a lock left behind by a dead pid", async () => {
    const store = new FsArtifactStore(projectDir);
    await mkdir(path.join(projectDir, ".twin"), { recursive: true });
    // A pid that (almost certainly) does not exist.
    await writeFile(path.join(projectDir, ".twin", "lock.7"), STALE, "utf8");

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

/**
 * Found by an external audit: a live pid is not a live run. In a container
 * Twin is often pid 1, so after one killed run every later run found "pid 1"
 * alive and refused - forever, since `twin clean` reported nothing to do and
 * left the lock in place.
 */
describe("FsArtifactStore: who really holds a lock", () => {
  let projectDir: string;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-lockholder-"));
    await mkdir(path.join(projectDir, ".twin"), { recursive: true });
  });

  afterEach(async () => {
    for (const child of children.splice(0)) child.kill();
    await rm(projectDir, { recursive: true, force: true });
  });

  const writeLock = (contents: object): Promise<void> =>
    writeFile(path.join(projectDir, ".twin", "lock.1"), JSON.stringify({ startedAt: "x", token: "theirs", ...contents }), "utf8");

  /** A live process whose command line includes `marker`. */
  const liveProcess = (marker: string): number => {
    const child = spawn(process.execPath, ["-e", `setTimeout(() => {}, 60000) // ${marker}`], { stdio: "ignore" });
    children.push(child);
    return child.pid!;
  };

  it("reclaims a lock carrying our own pid that this process doesn't hold - the pid-1-in-a-container case", async () => {
    await writeLock({ pid: process.pid, command: "anything" });
    await (await new FsArtifactStore(projectDir).acquireLock()).release();
  });

  it("reclaims a lock whose pid is alive but has been reused by something else", async () => {
    await writeLock({ pid: liveProcess("unrelated-program"), command: "/opt/twin/dist/cli/index.js" });
    await (await new FsArtifactStore(projectDir).acquireLock()).release();
  }, 60_000); // a cold Windows CIM query can take 10s+, and is retried once

  it("still refuses a lock whose live pid looks like the run that wrote it", async () => {
    await writeLock({ pid: liveProcess("twin-cli-marker.js"), command: "twin-cli-marker.js" });
    await expect(new FsArtifactStore(projectDir).acquireLock()).rejects.toMatchObject({ code: "E_LOCKED" });
  }, 60_000); // a cold Windows CIM query can take 10s+, and is retried once

  it("lets twin clean clear a dead run's lock, and leaves a live one alone", async () => {
    await writeLock({ pid: 999_999 });
    expect(await new FsArtifactStore(projectDir).clearStaleLock()).toEqual({ cleared: true });
    expect(await lockFiles(projectDir)).toEqual([]);

    await writeLock({ pid: liveProcess("twin-cli-marker.js"), command: "twin-cli-marker.js" });
    const kept = await new FsArtifactStore(projectDir).clearStaleLock();
    expect(kept.cleared).toBe(false);
    expect(kept.holder).toBeDefined();
    expect(await lockFiles(projectDir)).toEqual(["lock.1"]);
  }, 60_000); // a cold Windows CIM query can take 10s+, and is retried once

  /**
   * Audit, third round: on Windows the OS often won't show another process's
   * command line, and such a holder counts as held. That must never be a
   * permanent lockout - the refusal has to say why, and name the way out.
   */
  describe("when the holder's command line can't be read", () => {
    beforeEach(() => {
      commandLine.unreadable = true;
    });
    afterEach(() => {
      commandLine.unreadable = false;
    });

    it("refuses, says it couldn't confirm the holder, and names twin clean --unlock", async () => {
      const pid = liveProcess("some-other-program");
      await writeLock({ pid, command: "/opt/twin/dist/cli/index.js" });
      const err = await new FsArtifactStore(projectDir).acquireLock().then(
        () => undefined,
        (e: unknown) => e as TwinError
      );
      expect(err?.code).toBe("E_LOCKED");
      expect(err?.message).toContain("can't confirm it is a Twin run");
      expect(err?.hint).toContain("twin clean --unlock");
    }, 60_000); // a cold Windows CIM query can take 10s+, and is retried once

    it("leaves the lock to a plain clean, and --unlock removes it so the next run gets in", async () => {
      await writeLock({ pid: liveProcess("some-other-program"), command: "/opt/twin/dist/cli/index.js" });

      const plain = await new FsArtifactStore(projectDir).clearStaleLock();
      expect(plain).toMatchObject({ cleared: false, holder: { confirmed: false } });

      expect(await new FsArtifactStore(projectDir).clearStaleLock({ force: true })).toEqual({ cleared: true });
      expect(await lockFiles(projectDir)).toEqual([]);
      await (await new FsArtifactStore(projectDir).acquireLock()).release();
    }, 60_000); // a cold Windows CIM query can take 10s+, and is retried once
  });
});
