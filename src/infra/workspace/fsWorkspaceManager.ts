import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";

import type { InstanceId } from "../../domain/instance.js";
import type { FileEntry } from "../../domain/workspaceDiff.js";
import type { WorkspaceManager, WorkspaceOptions } from "../../ports/workspaceManager.js";

const DEFAULT_IGNORE = [".git", ".twin", "node_modules"];
const SHA1_SIZE_LIMIT = 5 * 1024 * 1024;

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
      const stats = await stat(fullPath);
      const relativePath = path.relative(baseDir, fullPath).split(path.sep).join("/");
      const sha1 = stats.size < SHA1_SIZE_LIMIT ? createHash("sha1").update(await readFile(fullPath)).digest("hex") : undefined;
      out.push({ path: relativePath, size: stats.size, mtimeMs: stats.mtimeMs, sha1 });
    }
  }
}

interface PristineRecord {
  sourceDir: string;
  options: WorkspaceOptions;
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
    const skip = new Set([...DEFAULT_IGNORE, ...options.ignore, ...options.link]);

    await mkdir(dest, { recursive: true });
    await cp(resolvedSource, dest, {
      recursive: true,
      filter: (source) => !skip.has(path.basename(source))
    });

    this.pristineBySource.set(resolvedSource, dest);
    this.recordsByPristine.set(dest, { sourceDir: resolvedSource, options });
    return dest;
  }

  async cloneForInstance(pristineDir: string, instance: InstanceId): Promise<string> {
    const record = this.recordsByPristine.get(pristineDir);
    if (!record) {
      throw new Error(`cloneForInstance: ${pristineDir} was not created by preparePristine()`);
    }

    const dest = path.join(this.root, instance);
    await mkdir(dest, { recursive: true });
    await cp(pristineDir, dest, { recursive: true });

    for (const name of record.options.link) {
      const target = path.join(record.sourceDir, name);
      const linkPath = path.join(dest, name);
      try {
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
