import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { isWithin, type FileState } from "../../domain/sharedDisk.js";

/**
 * Where a store shared by accident usually lives: the system temp directory
 * (a hardcoded `/tmp/items.json`, a SQLite file, PHP's `sess_*` session
 * files). Only files directly in it are read - its subdirectories are other
 * programs' and other runs' workspaces, and reading them would mistake their
 * writes for the app's.
 */
const SHARED_DATA_FILE = /(\.(json|jsonl|ndjson|db|sqlite|sqlite3|db3|csv|dat)(-wal|-shm|-journal)?$|^sess_)/i;

/** A watched directory is read this deep and no further - an uploads dir, not a disk. */
const MAX_DEPTH = 3;
const MAX_FILES = 2_000;

export interface SnapshotPlan {
  /** Absolute paths from the env: each a file or a directory, existing yet or not. */
  envPaths: readonly string[];
  /** Directories whose top-level data files are watched (os.tmpdir(), /tmp). */
  tmpDirs: readonly string[];
  /** Never reported: the project, Twin's own workspaces, declared shared storage. */
  exclude: readonly string[];
}

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

/** The size and mtime of every watched file, keyed by path. Unreadable paths are skipped. */
export async function snapshotSharedPaths(plan: SnapshotPlan): Promise<Map<string, FileState>> {
  const out = new Map<string, FileState>();
  const excluded = (p: string): boolean => plan.exclude.some((root) => isWithin(p, root, path.sep, CASE_INSENSITIVE));

  const record = async (file: string): Promise<void> => {
    if (out.size >= MAX_FILES || excluded(file)) return;
    try {
      const info = await stat(file);
      if (info.isFile()) out.set(file, { size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // gone, or not ours to read
    }
  };

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.size >= MAX_FILES || excluded(dir)) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile()) await record(full);
    }
  };

  for (const envPath of plan.envPaths) {
    const resolved = path.resolve(envPath);
    try {
      const info = await stat(resolved);
      if (info.isDirectory()) await walk(resolved, 0);
      else await record(resolved);
    } catch {
      // Doesn't exist yet. If the run creates it, the second snapshot sees it.
    }
  }

  for (const dir of plan.tmpDirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && SHARED_DATA_FILE.test(entry.name)) await record(path.join(dir, entry.name));
    }
  }

  return out;
}
