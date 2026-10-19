import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCommand } from "../../src/cli/commands/run.js";
import { collectEnvCandidates } from "../../src/domain/envSources.js";
import { findDatastoreSettings } from "../../src/domain/safetyScan.js";
import type { Logger } from "../../src/ports/logger.js";

const APP = `
require("node:http").createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(req.url === "/health" ? { ok: true } : { user: "alice" }));
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

const SCENARIO = `name: note
version: 1
steps:
  - id: me
    kind: request
    request: { method: GET, path: /me }
    expect: { status: 200 }
    check: session-survives-switch
`;

/**
 * "The scenario writes real records to the database your app is configured
 * with" used to be said on every run without a "setup" - including for apps
 * with no database at all, which taught people to skip it. It's said when
 * the app has one: a database-looking env var, or a connection string in the
 * env or the code.
 */
describe("the note that Twin doesn't remove what a run writes to the database", () => {
  let projectDir: string;
  const ambient: Record<string, string> = {};

  beforeEach(async () => {
    // This shell's own environment counts too - and a developer's may well
    // point at a database. Each test decides for itself.
    for (const key of findDatastoreSettings(collectEnvCandidates([{ name: "shell", vars: process.env }]), [])) {
      ambient[key] = process.env[key]!;
      delete process.env[key];
    }
    projectDir = await mkdtemp(path.join(os.tmpdir(), "db-note-fixture-"));
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "db-note-fixture", private: true }), "utf8");
    await writeFile(path.join(projectDir, "server.js"), APP, "utf8");
    await writeFile(path.join(projectDir, "scenario.yaml"), SCENARIO, "utf8");
  });

  afterEach(async () => {
    Object.assign(process.env, ambient);
    for (const key of Object.keys(ambient)) delete ambient[key];
    await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function notes(env: Record<string, string>, extra: { setup?: string } = {}): Promise<string[]> {
    const said: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: (message) => void said.push(message),
      warn: () => {},
      error: () => {},
      child: () => logger
    };
    const code = await runCommand(
      {
        projectDir,
        scenarioPath: path.join(projectDir, "scenario.yaml"),
        env,
        start: "node server.js",
        bootTimeoutMs: 30_000,
        keepWorkspaces: false,
        allowRemote: false,
        ...extra
      },
      logger
    );
    expect(code).toBe(0);
    return said.filter((message) => message.includes("Twin does not remove"));
  }

  it("isn't said for an app with no database configured", async () => {
    expect(await notes({})).toEqual([]);
  }, 90_000);

  it("is said, naming the setting, for a database-looking env var - a local database included", async () => {
    const said = await notes({ DATABASE_URL: "postgres://localhost:5432/dev" });
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("DATABASE_URL");
  }, 90_000);

  // The run's own throwaway directory, which Twin creates and removes.
  it("isn't said for a database under {{shared}}, even with a real one in the project's .env", async () => {
    await writeFile(path.join(projectDir, ".env"), "DATABASE_URL=postgres://localhost:5432/dev\n", "utf8");
    expect(await notes({ DATABASE_URL: "sqlite:///{{shared}}/twin.db" })).toEqual([]);
  }, 90_000);

  it("is said for a connection string written into the code", async () => {
    await writeFile(path.join(projectDir, "db.js"), 'module.exports = "mongodb://localhost:27017/app";\n', "utf8");
    const said = await notes({});
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("db.js");
  }, 90_000);

  it("isn't said when a setup command resets the database before each phase", async () => {
    await writeFile(path.join(projectDir, "reset.js"), "", "utf8");
    expect(await notes({ DATABASE_URL: "postgres://localhost:5432/dev" }, { setup: "node reset.js" })).toEqual([]);
  }, 90_000);
});
