import type { InstanceId } from "./instance.js";

/** One file in a workspace snapshot (§7.5): `path` is relative to the workspace root, so diffs are comparable across instances. */
export interface FileEntry {
  path: string;
  size: number;
  mtimeMs: number;
  /** Content hash. Absent only when the file couldn't be read at all, which makes it indeterminate, not unchanged. */
  sha1?: string | undefined;
  /**
   * True when `sha1` covers sampled chunks of a very large file rather than
   * all of it: equal sampled hashes mean "no change detected", never "identical".
   */
  sampled?: boolean | undefined;
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

/**
 * Deliberately biased toward reporting a change. This diff feeds the tracer,
 * which names the file a failing check should blame - so a file wrongly listed
 * as modified costs a weak suspect, while one wrongly called unchanged loses
 * the evidence entirely.
 *
 * That's why there is no size/mtime-only path any more: it used to be the
 * fallback for files too large to hash, and an in-place rewrite that kept the
 * same size, with an mtime collision from coarse filesystem granularity, read
 * as "unchanged".
 */
function isSameContent(a: FileEntry, b: FileEntry): boolean {
  // No content signal on one side (unreadable file): indeterminate, so say changed.
  if (a.sha1 === undefined || b.sha1 === undefined) return false;
  if (a.sha1 !== b.sha1) return false;
  // Matching sampled fingerprints leave the unsampled middle of a huge file
  // unaccounted for; a touched mtime or a changed size is enough to suspect it.
  if (a.sampled === true || b.sampled === true) return a.size === b.size && a.mtimeMs === b.mtimeMs;
  return true;
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
