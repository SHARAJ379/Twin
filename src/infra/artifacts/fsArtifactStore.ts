import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
   * 3. Reclaiming a stale lock must be conditional, and taking one must be
   *    confirmed by reading it back - otherwise two runs reclaiming the same
   *    stale lock delete each other's fresh one.
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
        // Read back before trusting it. A peer that judged a *previous* lock
        // stale can delete this one - the file it inspected is gone by then -
        // and take the lock itself; if that happened, the token here is theirs
        // and we must not go on to share this project's .twin with them.
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
      // Stale, or unreadable and so unattributable. Reclaim it - but only if
      // it is still the very file just judged, never whatever is there now.
      await this.removeLockIfUnchanged(lockPath, existing);
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
    const tmpPath = `${lockPath}.${contents.token}.tmp`;
    await writeFile(tmpPath, JSON.stringify(contents), "utf8");
    try {
      await link(tmpPath, lockPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      return false;
    } finally {
      await rm(tmpPath, { force: true });
    }
  }

  /**
   * Deletes the lock only if it is still the one the caller inspected and
   * judged reclaimable. Two runs that both see the same stale lock would
   * otherwise delete in turn - the second deleting the *fresh* lock the first
   * had just taken - and both would then believe they held it.
   */
  private async removeLockIfUnchanged(lockPath: string, judged: LockFileContents | null): Promise<void> {
    const current = await this.readLockFile(lockPath);
    const unchanged = judged === null ? current === null : current !== null && current.token === judged.token;
    if (unchanged) await rm(lockPath, { force: true });
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
