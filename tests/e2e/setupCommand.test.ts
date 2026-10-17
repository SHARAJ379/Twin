import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCommand } from "../../src/cli/commands/run.js";
import { ConsoleLogger } from "../../src/infra/log/consoleLogger.js";

const logger = new ConsoleLogger({ level: "error" });

/**
 * A "database" in a file both instances share (DB_FILE, standing in for a
 * real database server), which every signup appends to - the way a dev
 * database fills up with test users, run after run.
 */
const APP = `
const http = require("node:http");
const fs = require("node:fs");
const read = () => { try { return JSON.parse(fs.readFileSync(process.env.DB_FILE, "utf8")); } catch { return []; } };
http.createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/health") return send(200, { ok: true });
  if (req.method === "POST" && req.url === "/users") {
    const users = read();
    users.push({ id: users.length + 1 });
    fs.writeFileSync(process.env.DB_FILE, JSON.stringify(users));
    return send(201, { id: users.length });
  }
  if (req.url.startsWith("/users/")) {
    const user = read().find((u) => String(u.id) === req.url.slice(7));
    return user ? send(200, user) : send(404, {});
  }
  send(404, {});
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

// Resets the "database", and records each call with the phase and env it got.
const RESET = `
const fs = require("node:fs");
fs.rmSync(process.env.DB_FILE, { force: true });
fs.appendFileSync("setup-calls.txt", process.env.TWIN_PHASE + " " + path() + "\\n");
function path() { return require("node:path").basename(process.env.DB_FILE); }
if (process.env.FAIL_SETUP === "1") { console.error("could not reach the database"); process.exit(3); }
`;

const SCENARIO = `name: signup
version: 1
steps:
  - id: signup
    kind: request
    via: A
    request: { method: POST, path: /users }
    expect: { status: 201 }
    save: { id: "$.id" }
  - id: read-back
    kind: request
    via: B
    request: { method: GET, path: "/users/{{id}}" }
    expect: { status: 200 }
    check: data-consistency
`;

/**
 * Audit, third round: every run left its test records in the user's dev
 * database for good. "setup" runs a reset before each phase, in the project,
 * with the env the instances get.
 */
describe("the setup command", () => {
  let projectDir: string;
  let dbDir: string;

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function project(config: object): Promise<void> {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "setup-fixture-"));
    dbDir = await mkdtemp(path.join(os.tmpdir(), "setup-db-"));
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "setup-fixture", private: true }), "utf8");
    await writeFile(path.join(projectDir, "server.js"), APP, "utf8");
    await writeFile(path.join(projectDir, "reset.js"), RESET, "utf8");
    await writeFile(path.join(projectDir, "scenario.yaml"), SCENARIO, "utf8");
    await writeFile(path.join(projectDir, "twin.config.json"), JSON.stringify(config), "utf8");
  }

  const run = (env: Record<string, string> = {}): Promise<number> =>
    runCommand(
      {
        projectDir,
        env: { DB_FILE: path.join(dbDir, "db.json"), ...env },
        start: "node server.js",
        bootTimeoutMs: 30_000,
        keepWorkspaces: false,
        allowRemote: false
      },
      logger
    );

  it("runs before CONTROL and before SPLIT, so the run leaves only one phase's records behind", async () => {
    await project({ scenario: "scenario.yaml", setup: "node reset.js" });

    expect(await run()).toBe(0);

    expect(await readFile(path.join(projectDir, "setup-calls.txt"), "utf8")).toBe("CONTROL db.json\nSPLIT db.json\n");
    // CONTROL's signup was reset away before SPLIT's.
    expect(JSON.parse(await readFile(path.join(dbDir, "db.json"), "utf8"))).toEqual([{ id: 1 }]);
  }, 90_000);

  it("stops the run with E_SETUP_FAILED, before booting anything, when it fails", async () => {
    await project({ scenario: "scenario.yaml", setup: "node reset.js" });

    const err = await run({ FAIL_SETUP: "1" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "E_SETUP_FAILED" });
    expect((err as { details: { logTail: string[] } }).details.logTail.join("\n")).toContain("could not reach the database");
    await expect(readFile(path.join(dbDir, "db.json"), "utf8")).rejects.toThrow();
  }, 90_000);
});
