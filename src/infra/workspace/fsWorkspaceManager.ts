import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, open, readdir, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import type { InstanceId } from "../../domain/instance.js";
import type { FileEntry } from "../../domain/workspaceDiff.js";
import type { WorkspaceManager, WorkspaceOptions } from "../../ports/workspaceManager.js";

const DEFAULT_IGNORE = [".git", ".twin", "node_modules"];
/**
 * Hashed in full up to here, streamed rather than buffered. Twin's workspaces
 * are app source plus whatever the app writes - a SQLite file, an upload dir -
 * with node_modules and .git already excluded, so this covers everything that
 * matters while keeping a giant fixture from being read end to end four times
 * a run (before and after, per instance).
 */
export const FULL_HASH_LIMIT = 64 * 1024 * 1024;
/** Above the limit: head, middle and tail, which catches the writes a datastore actually makes. */
const SAMPLE_CHUNK_BYTES = 256 * 1024;

/** A streamed sha1 - never loads the whole file into memory. */
async function hashWholeFile(fullPath: string): Promise<string> {
  const hash = createHash("sha1");
  await pipeline(createReadStream(fullPath), hash);
  return hash.digest("hex");
}

/**
 * Three chunks plus the size. Not a proof of equality, which is why the entry
 * is marked `sampled` and the diff treats a match as "no change detected".
 */
async function hashSampledFile(fullPath: string, size: number): Promise<string> {
  const hash = createHash("sha1").update(`size:${size}`);
  const handle = await open(fullPath, "r");
  try {
    const buffer = Buffer.allocUnsafe(SAMPLE_CHUNK_BYTES);
    const offsets = [0, Math.max(0, Math.floor(size / 2) - SAMPLE_CHUNK_BYTES / 2), Math.max(0, size - SAMPLE_CHUNK_BYTES)];
    for (const offset of offsets) {
      const { bytesRead } = await handle.read(buffer, 0, SAMPLE_CHUNK_BYTES, offset);
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function fingerprint(fullPath: string, size: number): Promise<{ sha1?: string; sampled?: boolean }> {
  try {
    return size <= FULL_HASH_LIMIT
      ? { sha1: await hashWholeFile(fullPath) }
      : { sha1: await hashSampledFile(fullPath, size), sampled: true };
  } catch {
    // Unreadable (locked, vanished, permission) - record the entry without a
    // hash. The diff reads a missing hash as indeterminate, so the file gets
    // reported as changed rather than silently assumed identical.
    return {};
  }
}

async function walk(dir: string, baseDir: string, skip: ReadonlySet<string>, out: FileEntry[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // directory vanished mid-walk (e.g. a dead instance's tmp dir) - nothing to report
  }

  for (const entry of entries) {
    if (skip.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await walk(fullPath, baseDir, skip, out);
    } else if (entry.isFile()) {
      // Dirent.isDirectory()/isFile() don't follow symlinks, so the
      // node_modules junction itself is walked into as "not a file, not a
      // directory" and silently skipped - exactly what we want, since its
      // contents are shared across instances and not instance-specific state.
      let stats;
      try {
        stats = await stat(fullPath);
      } catch {
        continue; // a temp file the app wrote and removed between readdir and
        // now: it isn't there to snapshot, and throwing here would fail the run
      }
      const relativePath = path.relative(baseDir, fullPath).split(path.sep).join("/");
      out.push({ path: relativePath, size: stats.size, mtimeMs: stats.mtimeMs, ...(await fingerprint(fullPath, stats.size)) });
    }
  }
}

interface PristineRecord {
  sourceDir: string;
  options: WorkspaceOptions;
  /**
   * Project-relative paths of every directory that has to be linked rather
   * than copied - at whatever depth it was found, not just the root. A
   * monorepo or npm-workspaces project has a `node_modules` per package, and
   * the copy filter drops all of them by name; linking only the root one back
   * left those packages without their dependencies, so the app couldn't boot.
   */
  linkPaths: string[];
}

/**
 * FS-backed WorkspaceManager, rooted at a single run's tmp directory
 * (TWIN_ARCHITECTURE.md §7.5). `link` directories (node_modules, .venv) are
 * never copied into the pristine tree; each instance junctions/symlinks them
 * straight from the real project so every instance shares one install.
 */
export class FsWorkspaceManager implements WorkspaceManager {
  private readonly pristineBySource = new Map<string, string>();
  private readonly recordsByPristine = new Map<string, PristineRecord>();

  constructor(private readonly root: string) {}

  async preparePristine(sourceDir: string, options: WorkspaceOptions): Promise<string> {
    const resolvedSource = path.resolve(sourceDir);
    const cached = this.pristineBySource.get(resolvedSource);
    if (cached) return cached;

    const dest = path.join(this.root, "pristine", path.basename(resolvedSource));
    const ignore = new Set([...DEFAULT_IGNORE, ...options.ignore]);
    const link = new Set(options.link);
    // Collected during the copy rather than by a second walk: the filter
    // already visits every path, and cp never descends into one it rejects -
    // so a node_modules nested inside another is never reported.
    const linkPaths: string[] = [];

    await mkdir(dest, { recursive: true });
    await cp(resolvedSource, dest, {
      recursive: true,
      filter: (source) => {
        const name = path.basename(source);
        if (link.has(name)) {
          linkPaths.push(path.relative(resolvedSource, source));
          return false;
        }
        return !ignore.has(name);
      }
    });

    this.pristineBySource.set(resolvedSource, dest);
    this.recordsByPristine.set(dest, { sourceDir: resolvedSource, options, linkPaths });
    return dest;
  }

  /**
   * A *clean* copy of the pristine tree. The directory is removed first, which
   * is the whole contract: `restart` with `disk: "fresh"` clones over the same
   * path, and this used to copy into whatever was already there. Files the app
   * had created at runtime - a SQLite database, a JSON store, an upload -
   * aren't in the pristine tree, so nothing overwrote them and they survived
   * the "fresh" restart. restart-persistence then passed for an app that keeps
   * its data in a runtime-created file, which is exactly the app it exists to
   * fail.
   *
   * Removing the directory can't reach outside it: the link entries are
   * junctions/symlinks, and `fs.rm` unlinks those rather than following them,
   * so the real project's node_modules is never touched (proved by a test).
   */
  async cloneForInstance(pristineDir: string, instance: InstanceId): Promise<string> {
    const record = this.recordsByPristine.get(pristineDir);
    if (!record) {
      throw new Error(`cloneForInstance: ${pristineDir} was not created by preparePristine()`);
    }

    const dest = path.join(this.root, instance);
    // Same retries as cleanup(): a just-killed instance can still hold a
    // handle inside its old workspace for a few ms on Windows.
    await rm(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await mkdir(dest, { recursive: true });
    await cp(pristineDir, dest, { recursive: true });

    for (const relativePath of record.linkPaths) {
      const target = path.join(record.sourceDir, relativePath);
      const linkPath = path.join(dest, relativePath);
      try {
        // A nested link (packages/web/node_modules) needs its parent to exist;
        // the parent is in the pristine tree, but only if it held something
        // else worth copying.
        await mkdir(path.dirname(linkPath), { recursive: true });
        await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
      } catch {
        // Nothing at `target` to link (e.g. the project has no node_modules yet) - fine, skip it.
      }
    }

    return dest;
  }

  async snapshot(dir: string): Promise<FileEntry[]> {
    const out: FileEntry[] = [];
    await walk(dir, dir, new Set(DEFAULT_IGNORE), out);
    return out;
  }

  async cleanup(): Promise<void> {
    // maxRetries/retryDelay: on Windows a just-killed instance can hold its
    // cwd's directory handle for a few ms after the kill call returns, so an
    // immediate recursive rm can see a transient EBUSY/ENOTEMPTY.
    await rm(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
