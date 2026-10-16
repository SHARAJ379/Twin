import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { TwinError } from "../../domain/errors.js";
import type { ArtifactStore, Lock, RunHandle } from "../../ports/artifactStore.js";
import { isProcessAlive } from "../process/isProcessAlive.js";

interface LockFileContents {
  pid: number;
  startedAt: string;
  /** Distinguishes our own lock file instance so release() never deletes a lock someone else now owns. */
  token: string;
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
   * Three things are needed to actually exclude a peer, and the first two were
   * each tried alone and weren't enough:
   *
   * 1. The create must be exclusive. Reading the path and then writing it left
   *    a window in which both runs saw no lock.
   * 2. The file must become visible already complete (see tryCreateLockFile).
   *    An exclusive create still publishes it empty for a moment, and a peer
   *    reading it then saw an unparseable lock and reclaimed it as stale.
   * 3. Reclaiming a stale lock must itself be atomic - a rename, not a read
   *    and then a delete (see stealStaleLock). Checking the token before
   *    deleting narrowed that window without closing it: two runs could both
   *    pass the check, and the slower delete then landed on the fresh lock the
   *    faster run had already taken.
   *
   * And taking the lock is confirmed by reading it back, so that if any of
   * this is still wrong, the outcome is a refusal rather than two holders.
   */
  async acquireLock(): Promise<Lock> {
    await mkdir(this.root, { recursive: true });
    const lockPath = path.join(this.root, "lock");

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

    let acquired = false;
    // Three attempts: each one can lose a reclaim race to a peer, and losing
    // twice in a row means someone else is winning, which is a refusal.
    for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
      if (await this.tryCreateLockFile(lockPath, contents)) {
        // Read back before trusting it: the belt to stealStaleLock's braces.
        // If anything did move this file out from under us, the token here is
        // someone else's, and we must refuse rather than go on to share this
        // project's .twin with them.
        const seen = await this.readLockFile(lockPath);
        if (seen !== null && seen.token === contents.token) {
          acquired = true;
          break;
        }
        if (seen !== null && isProcessAlive(seen.pid)) throw held(seen);
        continue;
      }

      const existing = await this.readLockFile(lockPath);
      if (existing !== null && isProcessAlive(existing.pid)) throw held(existing);
      // Stale, or unreadable and so unattributable. Reclaiming it is a steal,
      // not a delete: exactly one racing run can rename it away, and the
      // others go round again to look at whatever is there now.
      await this.stealStaleLock(lockPath, contents.token);
    }

    if (!acquired) {
      throw new TwinError("E_LOCKED", "Could not take this project's Twin lock.", {
        hint: "Another `twin run` is starting at the same moment. Try again, or run `twin clean`.",
        exitCode: 2
      });
    }

    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        const current = await this.readLockFile(lockPath);
        // Only remove the lock file if it's still the one we wrote.
        if (current !== null && current.token === contents.token) {
          await rm(lockPath, { force: true });
        }
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

  /**
   * Creates the lock file complete, or reports that someone else got there.
   *
   * Written to a temp path and hard-linked into place, because `link` both
   * fails on an existing target and publishes the file already populated.
   * `open(..., "wx")` is exclusive but creates the file *empty* and fills it a
   * moment later, and a peer that read it inside that window got an
   * unparseable lock, concluded it was stale, deleted it and took the lock -
   * so both runs held it, which is the thing the exclusive create was for.
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
      // brief window where the file exists empty, which the read-back check
      // after acquiring is there to catch anyway.
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

  /**
   * Takes a stale lock out of the way, atomically, and says whether this
   * process is the one that did it.
   *
   * `rename` is the whole mechanism: the destination is unique per attempt, so
   * two runs renaming the same lock cannot both succeed - the loser finds
   * nothing there and gets ENOENT. Checking the token and *then* deleting
   * looked equivalent and wasn't: both runs could pass the check, and the
   * second `rm` would land on the fresh lock the first had already taken,
   * leaving two runs each believing they held it. A read followed by a write
   * is not a compare-and-swap, which is the same mistake this lock has now
   * made twice, in two different spellings.
   */
  private async stealStaleLock(lockPath: string, token: string): Promise<boolean> {
    const graveyard = `${lockPath}.stale.${token}`;
    try {
      await rename(lockPath, graveyard);
      await rm(graveyard, { force: true });
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOENT: someone else got there first. Anything else (a Windows share
      // violation, say) is also "not ours to reclaim" - either way, go back
      // and look at what is there now.
      if (code === "ENOENT" || code === "EPERM" || code === "EACCES" || code === "EBUSY") return false;
      throw err;
    }
  }

  private async readLockFile(lockPath: string): Promise<LockFileContents | null> {
    try {
      const raw = await readFile(lockPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<LockFileContents>;
      if (typeof parsed.pid === "number" && typeof parsed.startedAt === "string" && typeof parsed.token === "string") {
        return { pid: parsed.pid, startedAt: parsed.startedAt, token: parsed.token };
      }
      return null;
    } catch {
      return null;
    }
  }
}
