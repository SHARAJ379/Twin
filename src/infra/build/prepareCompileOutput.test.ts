import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Logger } from "../../ports/logger.js";
import { prepareCompileOutput, type SystemDirs } from "./prepareCompileOutput.js";

function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  const logger = {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (message: string) => void warnings.push(message),
    error: () => {},
    child: () => logger
  };
  return logger;
}

/** This OS, with its user cache dir (wherever this platform keeps it) under `cacheRoot`'s home. */
function systemWith(home: string, tmpdir: string): SystemDirs {
  return {
    platform: process.platform,
    env: { LOCALAPPDATA: path.join(home, "AppData", "Local"), XDG_CACHE_HOME: path.join(home, ".cache") },
    homedir: home,
    tmpdir
  };
}

describe("prepareCompileOutput", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "twin-compile-out-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("creates the executable's folder in the user cache dir, and gives the same path every time", async () => {
    const logger = recordingLogger();
    const system = systemWith(path.join(root, "home"), path.join(root, "tmp"));
    const first = await prepareCompileOutput(path.join(root, "project"), logger, system);

    expect(first.startsWith(path.join(root, "home"))).toBe(true);
    expect(first.split(path.sep).slice(-4, -2)).toEqual(["twin", "bin"]);
    expect((await stat(path.dirname(first))).isDirectory()).toBe(true);
    expect(await prepareCompileOutput(path.join(root, "project"), logger, system)).toBe(first);
    expect(logger.warnings).toEqual([]);
  });

  it("falls back to the temp dir, same layout, when the cache dir can't be created", async () => {
    const logger = recordingLogger();
    // A file where the home directory should be: nothing can be created under it.
    const home = path.join(root, "not-a-dir");
    await writeFile(home, "", "utf8");
    const output = await prepareCompileOutput(path.join(root, "project"), logger, systemWith(home, path.join(root, "tmp")));

    expect(output.startsWith(path.join(root, "tmp", "twin", "bin"))).toBe(true);
    expect((await stat(path.dirname(output))).isDirectory()).toBe(true);
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toContain("compiling into");
  });
});
