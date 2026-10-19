import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { genericStack } from "../../domain/stacks/generic.js";
import { findVirtualenvDirs, withProjectVirtualenvs } from "./virtualenvs.js";

describe("project virtualenvs", () => {
  let projectDir: string;

  afterEach(async () => {
    if (projectDir !== undefined) await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function project(venvs: string[], plainDirs: string[] = []): Promise<string> {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-venv-"));
    for (const dir of plainDirs) await mkdir(path.join(projectDir, dir), { recursive: true });
    for (const dir of venvs) {
      await mkdir(path.join(projectDir, dir), { recursive: true });
      await writeFile(path.join(projectDir, dir, "pyvenv.cfg"), "home = /usr/bin\n", "utf8");
    }
    return projectDir;
  }

  // Found dogfooding: a project with `.venv-backend` (PyTorch inside) was
  // copied whole into every workspace, because only `.venv`/`venv` were known.
  it("finds a virtualenv by its pyvenv.cfg, whatever it's called", async () => {
    const dir = await project([".venv-backend", "env-train"], ["app", "data"]);
    expect(await findVirtualenvDirs(dir)).toEqual([".venv-backend", "env-train"]);
  });

  it("links and ignores a virtualenv the stack doesn't already know", async () => {
    const dir = await project([".venv-backend"]);
    const stack = { ...genericStack, linkDirs: [".venv"], ignoreDirs: [".venv"] };

    const result = await withProjectVirtualenvs(stack, dir);

    expect(result.linkDirs).toEqual([".venv", ".venv-backend"]);
    expect(result.ignoreDirs).toEqual([".venv", ".venv-backend"]);
  });

  it("leaves the stack as it is when there's nothing new", async () => {
    const dir = await project([".venv"]);
    const stack = { ...genericStack, linkDirs: [".venv"], ignoreDirs: [".venv"] };

    expect(await withProjectVirtualenvs(stack, dir)).toBe(stack);
  });

  it("finds nothing in a directory that doesn't exist", async () => {
    expect(await findVirtualenvDirs(path.join(os.tmpdir(), "twin-no-such-dir-xyz"))).toEqual([]);
  });
});
