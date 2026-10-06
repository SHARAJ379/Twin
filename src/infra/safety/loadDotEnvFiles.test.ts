import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadDotEnvFiles } from "./loadDotEnvFiles.js";

describe("loadDotEnvFiles", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-dotenv-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("parses .env and merges .env.local on top", async () => {
    await writeFile(path.join(projectDir, ".env"), "DATABASE_URL=postgres://localhost/app\nFOO=bar\n", "utf8");
    await writeFile(path.join(projectDir, ".env.local"), "FOO=overridden\n", "utf8");

    const env = await loadDotEnvFiles(projectDir);
    expect(env["DATABASE_URL"]).toBe("postgres://localhost/app");
    expect(env["FOO"]).toBe("overridden");
  });

  it("handles quoted values the way dotenv does", async () => {
    await writeFile(projectDir + "/.env", 'GREETING="hello world"\n', "utf8");
    const env = await loadDotEnvFiles(projectDir);
    expect(env["GREETING"]).toBe("hello world");
  });

  it("returns {} when there are no .env files", async () => {
    expect(await loadDotEnvFiles(projectDir)).toEqual({});
  });

  it("returns {} for a project directory that doesn't exist", async () => {
    expect(await loadDotEnvFiles(path.join(projectDir, "nope"))).toEqual({});
  });

  it("ignores files that merely start with .env in the name but aren't dotenv files, like .environment", async () => {
    await writeFile(path.join(projectDir, ".environment"), "SHOULD_NOT=load", "utf8");
    const env = await loadDotEnvFiles(projectDir);
    expect(env).toEqual({});
  });
});
