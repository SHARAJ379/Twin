import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanOrphans } from "./clean.js";
import { ConsoleLogger } from "../../infra/log/consoleLogger.js";
import { WORKSPACE_GRACE_MS } from "../../infra/workspace/orphanWorkspaces.js";

const logger = new ConsoleLogger({ level: "error" });

describe("cleanOrphans", () => {
  let projectDir: string;
  let tmpDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-clean-project-"));
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "twin-clean-tmp-"));
  });

  afterEach(async () => {
    for (const dir of [projectDir, tmpDir]) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  async function staleWorkspace(): Promise<string> {
    const startedAt = new Date(Date.now() - 5 * WORKSPACE_GRACE_MS);
    const id = `${startedAt.toISOString().replace(/:/g, "-").replace(/\./g, "-")}-aaaaaaaa`;
    const dir = path.join(tmpDir, `twin-${id}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "marker"), "x", "utf8");
    await utimes(dir, startedAt, startedAt);
    return dir;
  }

  // The usual way a workspace gets stranded: the run that made it is long
  // gone, and with it (or with the project) the .twin/runs that named it.
  it("sweeps a stale workspace even when the project has no run history at all", async () => {
    const dir = await staleWorkspace();

    const result = await cleanOrphans(projectDir, logger, tmpDir);

    expect(result.workspacesRemoved).toEqual([dir]);
    expect(result.reaped).toEqual([]);
  });

  it("reports a workspace too new to sweep instead of removing it", async () => {
    const dir = path.join(tmpDir, `twin-${new Date().toISOString().replace(/:/g, "-").replace(/\./g, "-")}-bbbbbbbb`);
    await mkdir(dir, { recursive: true });

    const result = await cleanOrphans(projectDir, logger, tmpDir);

    expect(result.workspacesRemoved).toEqual([]);
    expect(result.workspacesKept).toEqual([dir]);
  });

  // The way out the E_LOCKED hint names: a lock whose live holder can't be
  // ruled out survives a plain clean, and --unlock removes it.
  it("removes a lock held by a live process only with --unlock", async () => {
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
      await mkdir(path.join(projectDir, ".twin"), { recursive: true });
      const lock = { pid: holder.pid, startedAt: "x", token: "theirs" }; // no command recorded: unconfirmable
      await writeFile(path.join(projectDir, ".twin", "lock.1"), JSON.stringify(lock), "utf8");
      const locks = async (): Promise<string[]> =>
        (await readdir(path.join(projectDir, ".twin"))).filter((name) => name.startsWith("lock"));

      await cleanOrphans(projectDir, logger, tmpDir);
      expect(await locks()).toEqual(["lock.1"]);

      await cleanOrphans(projectDir, logger, tmpDir, { unlock: true });
      expect(await locks()).toEqual([]);
    } finally {
      holder.kill();
    }
  });

  it("is a no-op with nothing to report on a clean machine", async () => {
    const result = await cleanOrphans(projectDir, logger, tmpDir);

    expect(result).toEqual({
      reaped: [],
      alreadyDead: [],
      skippedPidReuse: [],
      skippedUnverifiable: [],
      workspacesRemoved: [],
      workspacesKept: []
    });
  });
});
