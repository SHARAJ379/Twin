import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { compiledBinaryPath, userCacheDir } from "../../domain/compiledBinary.js";
import type { Logger } from "../../ports/logger.js";

export interface SystemDirs {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  homedir: string;
  tmpdir: string;
}

const thisSystem = (): SystemDirs => ({ platform: process.platform, env: process.env, homedir: os.homedir(), tmpdir: os.tmpdir() });

/**
 * Where to compile this project's executable (compiledBinary.ts), with its
 * folder created. Under the temp dir instead when the user cache dir can't be
 * created - a CI user without a writable home - in the same layout, so it is
 * still one path per project.
 */
export async function prepareCompileOutput(projectDir: string, logger: Logger, system: SystemDirs = thisSystem()): Promise<string> {
  const preferred = compiledBinaryPath({ projectDir, ...system });
  try {
    await mkdir(path.dirname(preferred), { recursive: true });
    return preferred;
  } catch (err) {
    const paths = system.platform === "win32" ? path.win32 : path.posix;
    const fallback = paths.join(system.tmpdir, paths.relative(userCacheDir(system), preferred));
    await mkdir(paths.dirname(fallback), { recursive: true });
    logger.warn(`couldn't create ${paths.dirname(preferred)} - compiling into ${paths.dirname(fallback)} instead`, {
      error: err instanceof Error ? err.message : String(err)
    });
    return fallback;
  }
}
