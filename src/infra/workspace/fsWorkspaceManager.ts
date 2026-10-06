import { cp, mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";

import type { InstanceId } from "../../domain/instance.js";
import type { WorkspaceManager, WorkspaceOptions } from "../../ports/workspaceManager.js";

const DEFAULT_IGNORE = [".git", ".twin", "node_modules"];

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

  async cleanup(): Promise<void> {
    // maxRetries/retryDelay: on Windows a just-killed instance can hold its
    // cwd's directory handle for a few ms after the kill call returns, so an
    // immediate recursive rm can see a transient EBUSY/ENOTEMPTY.
    await rm(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
