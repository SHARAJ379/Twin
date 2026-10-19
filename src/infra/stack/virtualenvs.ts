import { access, readdir } from "node:fs/promises";
import path from "node:path";

import type { StackProfile } from "../../domain/stack.js";

/** Every Python virtualenv has one at its root, whatever the directory is called. */
export const VIRTUALENV_MARKER = "pyvenv.cfg";

export async function isVirtualenv(dir: string): Promise<boolean> {
  try {
    await access(path.join(dir, VIRTUALENV_MARKER));
    return true;
  } catch {
    return false;
  }
}

/**
 * The project's top-level virtualenvs, by directory name. A stack only knows
 * `.venv` and `venv`; `.venv-backend` or `env-py312` was deep-copied into all
 * three workspaces (gigabytes, with PyTorch installed) and walked by every scan.
 */
export async function findVirtualenvDirs(projectDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && (await isVirtualenv(path.join(projectDir, entry.name)))) found.push(entry.name);
  }
  return found.sort();
}

/** `stack` with the project's own virtualenvs linked (shared, not copied) and left out of every scan. */
export async function withProjectVirtualenvs(stack: StackProfile, projectDir: string): Promise<StackProfile> {
  const extra = (await findVirtualenvDirs(projectDir)).filter((name) => !stack.linkDirs.includes(name));
  if (extra.length === 0) return stack;
  return {
    ...stack,
    linkDirs: [...stack.linkDirs, ...extra],
    ignoreDirs: [...stack.ignoreDirs, ...extra.filter((name) => !stack.ignoreDirs.includes(name))]
  };
}
