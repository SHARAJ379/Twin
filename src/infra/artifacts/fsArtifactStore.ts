import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { TwinError } from "../../domain/errors.js";
import type { ArtifactStore, Lock, RunHandle } from "../../ports/artifactStore.js";
import { isProcessAlive } from "../process/isProcessAlive.js";

interface LockFileContents {
  pid: number;
  startedAt: string;
  /** Distinguishes our own lock file instance from any other run's, including one with a recycled pid. */
  token: string;
  /** Written by release(): this generation is a tombstone, and the lock is free. */
  released?: boolean;
}

/** `lock.<generation>` - see acquireLock for why the lock is a series of files, not one. */
const LOCK_FILE = /^lock\.(\d+)$/;

/**
 * How long an unparseable lock file is presumed to be mid-write rather than
 * abandoned. Only the no-hard-links fallback in tryCreateLockFile ever
 * publishes a lock file before its contents.
 */
const UNREADABLE_LOCK_GRACE_MS = 5_000;

interface TopLock {
  generation: number;
  path: string;
  /** null when the file could not be parsed. */
  contents: LockFileContents | null;
  ageMs: number;
}

function makeRunId(now: Date): string {
  // Colons are invalid in Windows filenames, so this cannot be a raw ISO
  // string. Milliseconds and a random suffix are both load-bearing: the id
  // names this run's artifact dir AND its temp workspace root, so two runs
  // started in the same second would share both - and the first one's
  // cleanup() would delete the second's workspace out from under it. Fixed
  // widths keep a lexical sort chronological, which pruneOldRuns relies on.
  const stamp = now.toISOString().replace(/:/g, "-").replace(/\./g, "-");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

/** FS-backed ArtifactStore rooted at `<projectDir>/.twin` (invariant I2). */
export class FsArtifactStore implements ArtifactStore {
  private readonly root: string;

  constructor(private readonly projectDir: string) {
    this.root = path.join(projectDir, ".twin");
  }

  async createRun(): Promise<RunHandle> {
    const id = makeRunId(new Date());
    const dir = path.join(this.root, "runs", id);
    await mkdir(dir, { recursive: true });
    return { id, dir };
  }

  pathFor(run: RunHandle, name: string): string {
    return path.join(run.dir, name);
  }

  async writeLatestPointer(run: RunHandle): Promise<void> {
    // A plain pointer file, not a symlink: symlinks need elevated privileges
    // on Windows by default, so this must work identically on every OS.
    await mkdir(this.root, { recursive: true });
    await writeFile(path.join(this.root, "latest"), run.id, "utf8");
  }

  async readLatestRunId(): Promise<string | undefined> {
    try {
      return (await readFile(path.join(this.root, "latest"), "utf8")).trim();
    } catch {
      return undefined;
    }
  }

  getRun(id: string): RunHandle {
    return { id, dir: path.join(this.root, "runs", id) };
  }

  /**
   * Takes the project lock, or refuses. Two runs holding it at once means one
   * `.twin/` shared by both, racing on pids.json and the run directory.
   *
   * The lock is a series of files, `lock.1`, `lock.2`, ..., and the run that
   * holds it is the live owner of the highest-numbered one. Taking the lock
   * means exclusively creating the *next* number. Nothing is ever moved,
   * overwritten or deleted to take it - not even a stale lock.
   *
   * That is the whole point. Every earlier version of this lock had to get a
   * stale file out of the way, and every way of doing that acted on whatever
   * was at the path *by then*: read-then-delete deleted a fresh lock a peer had
   * just taken, and so did rename, which is atomic about the move and blind
   * about what it moves. A run that judged `lock.N` stale now creates
   * `lock.N+1`, and if any other run got there first - however long ago, and
   * whatever it then did - that create fails. The judgement and the claim can
   * no longer drift apart, because the claim names the thing judged.
   *
   * The read-back after creating stays. It is what catches a create on a
   * number that a later generation has already passed: generations below the
   * top are pruned, so a run that stalled long enough can create one again,
   * and it must then see that it isn't the top and withdraw.
   */
  async acquireLock(): Promise<Lock> {
    await mkdir(this.root, { recursive: true });

    const contents: LockFileContents = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      token: randomUUID()
    };

    const held = (existing: LockFileContents): TwinError =>
      new TwinError("E_LOCKED", `Another Twin run (pid ${existing.pid}) appears to be in progress in this project.`, {
        hint: "Wait for it to finish, or run `twin clean` if you're sure it's dead.",
        details: { pid: existing.pid, startedAt: existing.startedAt },
        exitCode: 2
      });
    const contended = (): TwinError =>
      new TwinError("E_LOCKED", "Could not take this project's Twin lock.", {
        hint: "Another `twin run` is starting at the same moment. Try again, or run `twin clean`.",
        exitCode: 2
      });

    // Three attempts: each one can lose the next generation to a peer, and
    // losing three times in a row means someone else is winning.
    for (let attempt = 0; attempt < 3; attempt++) {
      const top = await this.readTopLock();
      if (top !== undefined) {
        if (top.contents === null) {
          // Mid-write under the no-hard-links fallback, or a corpse. Only age
          // tells them apart, and treating a young one as stale is how this
          // lock once let two runs in.
          if (top.ageMs < UNREADABLE_LOCK_GRACE_MS) throw contended();
        } else if (!top.contents.released && isProcessAlive(top.contents.pid)) {
          throw held(top.contents);
        }
      }

      const generation = (top?.generation ?? 0) + 1;
      const ours = this.lockPath(generation);
      // EEXIST: a peer claimed this generation first. Go and look at it.
      if (!(await this.tryCreateLockFile(ours, contents))) continue;

      const now = await this.readTopLock();
      if (now?.generation === generation && now.contents?.token === contents.token) {
        await this.pruneLocksBelow(generation);
        return this.heldLock(generation, contents);
      }
      // A higher generation exists, so ours was never the lock. It is below
      // the top and can never become it again, so it is safe to withdraw.
      await rm(ours, { force: true });
    }

    throw contended();
  }

  private heldLock(generation: number, contents: LockFileContents): Lock {
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        const top = await this.readTopLock();
        if (top?.generation !== generation || top.contents?.token !== contents.token) {
          // Someone has since passed us - only possible if we were judged
          // dead. Their generation is the lock now; ours is just litter.
          await rm(this.lockPath(generation), { force: true });
          return;
        }
        // Releasing is another generation, not a delete or an overwrite: the
        // top file must never disappear or be rewritten in place, or a peer
        // could read it half-written, or a stalled peer could claim the
        // number again. A tombstone on top says "free" without either.
        const tombstone: LockFileContents = { ...contents, token: randomUUID(), released: true };
        if (await this.tryCreateLockFile(this.lockPath(generation + 1), tombstone)) {
          await this.pruneLocksBelow(generation + 1);
        }
        // If that create lost, a peer judged us dead and took generation+1.
        // Either way our file is no longer the top, and the next pruner takes it.
      }
    };
  }

  async pruneOldRuns(keep: number): Promise<void> {
    const runsDir = path.join(this.root, "runs");
    let entries: string[];
    try {
      entries = await readdir(runsDir);
    } catch {
      return; // no runs yet
    }

    const sorted = entries.sort().reverse(); // run ids are zero-padded ISO timestamps: lexical sort == chronological
    const toRemove = sorted.slice(keep);
    await Promise.all(toRemove.map((id) => rm(path.join(runsDir, id), { recursive: true, force: true })));
  }

  private lockPath(generation: number): string {
    return path.join(this.root, `lock.${generation}`);
  }

  private async lockGenerations(): Promise<number[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return [];
    }
    const generations: number[] = [];
    for (const name of entries) {
      const match = LOCK_FILE.exec(name);
      if (match?.[1] !== undefined) generations.push(Number(match[1]));
    }
    return generations.sort((a, b) => a - b);
  }

  private async readTopLock(): Promise<TopLock | undefined> {
    // Highest first. A generation can be pruned between the listing and the
    // read; that one is simply no longer the top, so look at the next.
    const generations = (await this.lockGenerations()).reverse();
    for (const generation of generations) {
      const lockPath = this.lockPath(generation);
      let ageMs: number;
      try {
        ageMs = Date.now() - (await stat(lockPath)).mtimeMs;
      } catch {
        continue;
      }
      return { generation, path: lockPath, contents: await this.readLockFile(lockPath), ageMs };
    }
    return undefined;
  }

  /**
   * Housekeeping only, so failures are ignored: a generation below the top is
   * never consulted again, and a file Windows won't let go of yet (antivirus
   * holding it open, say) is harmless where it is until the next prune.
   */
  private async pruneLocksBelow(generation: number): Promise<void> {
    const below = (await this.lockGenerations()).filter((g) => g < generation);
    await Promise.all(below.map((g) => rm(this.lockPath(g), { force: true }).catch(() => undefined)));
  }

  /**
   * Creates the lock file complete, or reports that someone else got there.
   *
   * Written to a temp path and hard-linked into place, because `link` both
   * fails on an existing target and publishes the file already populated.
   * `open(..., "wx")` is exclusive but creates the file *empty* and fills it a
   * moment later, and a peer that read it inside that window got an
   * unparseable lock, concluded it was stale, and took the lock - so both runs
   * held it, which is the thing the exclusive create was for.
   */
  private async tryCreateLockFile(lockPath: string, contents: LockFileContents): Promise<boolean> {
    const json = JSON.stringify(contents);
    const tmpPath = `${lockPath}.${contents.token}.tmp`;
    await writeFile(tmpPath, json, "utf8");
    try {
      await link(tmpPath, lockPath);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      // Not every filesystem has hard links - FAT/exFAT, and some network and
      // container bind mounts, answer EPERM/ENOTSUP/ENOSYS. Rethrowing meant
      // `twin run` could not take the lock there at all, so it refused to
      // start, every time. An exclusive create is the fallback: it leaves the
      // brief window where the file exists empty, which is why acquireLock
      // treats a young unreadable lock as held rather than stale.
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS" && code !== "EXDEV" && code !== "EACCES") throw err;
      try {
        await writeFile(lockPath, json, { encoding: "utf8", flag: "wx" });
        return true;
      } catch (fallbackErr) {
        if ((fallbackErr as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw fallbackErr;
      }
    } finally {
      await rm(tmpPath, { force: true });
    }
  }

  private async readLockFile(lockPath: string): Promise<LockFileContents | null> {
    try {
      const raw = await readFile(lockPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<LockFileContents>;
      if (typeof parsed.pid === "number" && typeof parsed.startedAt === "string" && typeof parsed.token === "string") {
        return { pid: parsed.pid, startedAt: parsed.startedAt, token: parsed.token, released: parsed.released === true };
      }
      return null;
    } catch {
      return null;
    }
  }
}
