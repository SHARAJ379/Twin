/** A single `twin run` invocation's artifact directory (TWIN_ARCHITECTURE.md §11). */
export interface RunHandle {
  id: string;
  dir: string;
}

export interface Lock {
  /** Releases the lock. Safe to call more than once. */
  release(): Promise<void>;
}

/**
 * Owns everything under `<project>/.twin/` (invariant I2: Twin never writes
 * outside this directory and its OS temp workspace).
 */
export interface ArtifactStore {
  /** Creates `.twin/runs/<run-id>/` and returns a handle to it. */
  createRun(): Promise<RunHandle>;
  /** Resolves an absolute path for an artifact file inside a run dir. */
  pathFor(run: RunHandle, name: string): string;
  /** Updates `.twin/latest` to point at this run. */
  writeLatestPointer(run: RunHandle): Promise<void>;
  /**
   * Acquires the single-run lock (`.twin/lock`). Throws TwinError("E_LOCKED")
   * if another live process holds it; a lock left behind by a dead PID is
   * detected and reclaimed automatically.
   */
  acquireLock(): Promise<Lock>;
  /** Deletes all but the `keep` most recent run directories. */
  pruneOldRuns(keep: number): Promise<void>;
}
