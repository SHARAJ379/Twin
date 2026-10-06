import type { InstanceId } from "../domain/instance.js";
import type { FileEntry } from "../domain/workspaceDiff.js";

export interface WorkspaceOptions {
  /** Directory names junction/symlinked from the source instead of deep-copied, e.g. "node_modules", ".venv". */
  link: string[];
  /** Extra top-level names to skip when copying, beyond the built-in .git/.twin/node_modules defaults. */
  ignore: string[];
}

/**
 * Builds the per-instance tmp directories instances actually run in
 * (TWIN_ARCHITECTURE.md §7.5). Never touches the user's source tree (I2).
 */
export interface WorkspaceManager {
  /** Makes (memoized) a pristine copy of `sourceDir`. Returns its absolute path. */
  preparePristine(sourceDir: string, options: WorkspaceOptions): Promise<string>;
  /** Clones the pristine copy into a fresh directory for `instance`. Returns its absolute path. */
  cloneForInstance(pristineDir: string, instance: InstanceId): Promise<string>;
  /** Walks `dir` (ignoring the same noise as copying - node_modules, .git, etc) and records each file (§7.5). */
  snapshot(dir: string): Promise<FileEntry[]>;
  /** Removes every workspace directory this manager created for this run. */
  cleanup(): Promise<void>;
}
