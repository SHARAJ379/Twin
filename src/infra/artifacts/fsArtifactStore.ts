import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  // Colons are invalid in Windows filenames, so this cannot be a raw ISO string.
  return now.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
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

  async acquireLock(): Promise<Lock> {
    await mkdir(this.root, { recursive: true });
    const lockPath = path.join(this.root, "lock");

    const existing = await this.readLockFile(lockPath);
    if (existing !== null && isProcessAlive(existing.pid)) {
      throw new TwinError(
        "E_LOCKED",
        `Another Twin run (pid ${existing.pid}) appears to be in progress in this project.`,
        {
          hint: "Wait for it to finish, or run `twin clean` if you're sure it's dead.",
          details: { pid: existing.pid, startedAt: existing.startedAt },
          exitCode: 2
        }
      );
    }
    // Missing lock, unreadable lock, or a stale PID: safe to reclaim.

    const contents: LockFileContents = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      token: randomUUID()
    };
    await writeFile(lockPath, JSON.stringify(contents), "utf8");

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
