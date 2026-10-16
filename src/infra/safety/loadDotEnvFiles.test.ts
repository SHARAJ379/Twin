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

  /** The merged view a caller builds for itself; the loader deliberately doesn't. */
  function merged(files: { name: string; vars: Record<string, string> }[]): Record<string, string> {
    return Object.assign({}, ...files.map((f) => f.vars)) as Record<string, string>;
  }

  it("keeps each file separate instead of merging them", async () => {
    await writeFile(path.join(projectDir, ".env"), "DATABASE_URL=postgres://localhost/app\nFOO=bar\n", "utf8");
    await writeFile(path.join(projectDir, ".env.local"), "FOO=overridden\n", "utf8");

    const files = await loadDotEnvFiles(projectDir);

    expect(files.map((f) => f.name)).toEqual([".env", ".env.local"]);
    expect(files[0]?.vars).toEqual({ DATABASE_URL: "postgres://localhost/app", FOO: "bar" });
    expect(files[1]?.vars).toEqual({ FOO: "overridden" });
    // Both values for FOO survive, which is the point: a caller that wants one
    // of them has to say which, and the safety scan looks at both.
    expect(merged(files)["FOO"]).toBe("overridden");
  });

  /**
   * The bug this file exists to prevent coming back: `.env.example` is
   * committed and holds placeholders, and merging it over `.env` turned a real
   * production DATABASE_URL into localhost - so the safety scan found nothing
   * remote and Twin would have written test traffic into the real database.
   */
  it("skips placeholder templates no app ever loads, so they can't mask a real value", async () => {
    await writeFile(path.join(projectDir, ".env"), "DATABASE_URL=postgres://user:pw@prod.db.supabase.co/app\n", "utf8");
    for (const name of [".env.example", ".env.sample", ".env.template", ".env.dist", ".env.local.example"]) {
      await writeFile(path.join(projectDir, name), "DATABASE_URL=postgres://localhost/app\n", "utf8");
    }

    const files = await loadDotEnvFiles(projectDir);

    expect(files.map((f) => f.name)).toEqual([".env"]);
    expect(merged(files)["DATABASE_URL"]).toContain("prod.db.supabase.co");
  });

  it("still reads .env.defaults, which dotenv-flow really does load", async () => {
    await writeFile(path.join(projectDir, ".env.defaults"), "DATABASE_URL=postgres://db.example.net/app\n", "utf8");
    expect((await loadDotEnvFiles(projectDir)).map((f) => f.name)).toEqual([".env.defaults"]);
  });

  it("handles quoted values the way dotenv does", async () => {
    await writeFile(path.join(projectDir, ".env"), 'GREETING="hello world"\n', "utf8");
    expect(merged(await loadDotEnvFiles(projectDir))["GREETING"]).toBe("hello world");
  });

  it("returns [] when there are no .env files", async () => {
    expect(await loadDotEnvFiles(projectDir)).toEqual([]);
  });

  it("returns [] for a project directory that doesn't exist", async () => {
    expect(await loadDotEnvFiles(path.join(projectDir, "nope"))).toEqual([]);
  });

  it("ignores files that merely start with .env in the name but aren't dotenv files, like .environment", async () => {
    await writeFile(path.join(projectDir, ".environment"), "SHOULD_NOT=load", "utf8");
    expect(await loadDotEnvFiles(projectDir)).toEqual([]);
  });
});
