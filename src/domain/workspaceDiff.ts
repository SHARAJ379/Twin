import type { InstanceId } from "./instance.js";

/** Populated starting milestone 5 (§7.5/§7.6); checks before that always receive []. */
export interface FileEntry {
  path: string;
  size: number;
}

export interface WorkspaceDiff {
  instance: InstanceId;
  added: FileEntry[];
  modified: FileEntry[];
  removed: FileEntry[];
}
