import type { InstanceId } from "./instance.js";

/** One file in a workspace snapshot (§7.5): `path` is relative to the workspace root, so diffs are comparable across instances. */
export interface FileEntry {
  path: string;
  size: number;
  mtimeMs: number;
  /** Only computed for files < 5MB (§7.5) - large files are compared by size/mtime alone. */
  sha1?: string | undefined;
}

export interface FsSnapshot {
  instance: InstanceId;
  entries: FileEntry[];
}

export interface WorkspaceDiff {
  instance: InstanceId;
  added: FileEntry[];
  modified: FileEntry[];
  removed: FileEntry[];
}

function isSameContent(a: FileEntry, b: FileEntry): boolean {
  if (a.sha1 !== undefined && b.sha1 !== undefined) return a.sha1 === b.sha1;
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Pure set comparison of two snapshots of the same instance, taken before/after a scenario run (§7.5). */
export function diffSnapshots(before: FsSnapshot, after: FsSnapshot): WorkspaceDiff {
  const beforeByPath = new Map(before.entries.map((e) => [e.path, e] as const));
  const afterByPath = new Map(after.entries.map((e) => [e.path, e] as const));

  const added: FileEntry[] = [];
  const modified: FileEntry[] = [];
  const removed: FileEntry[] = [];

  for (const [path, afterEntry] of afterByPath) {
    const beforeEntry = beforeByPath.get(path);
    if (beforeEntry === undefined) added.push(afterEntry);
    else if (!isSameContent(beforeEntry, afterEntry)) modified.push(afterEntry);
  }
  for (const [path, beforeEntry] of beforeByPath) {
    if (!afterByPath.has(path)) removed.push(beforeEntry);
  }

  return { instance: after.instance, added, modified, removed };
}
