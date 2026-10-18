import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCommand } from "../../src/cli/commands/run.js";
import { ConsoleLogger } from "../../src/infra/log/consoleLogger.js";

const logger = new ConsoleLogger({ level: "error" });

// Refuses to boot unless it was given the listen address the test expects -
// so a wrong one is an E_BOOT_CRASH carrying what it saw, not a quiet pass.
const APP = `
const http = require("node:http");
const seen = (name) => process.env[name] ?? "<unset>";
if (seen("HOST") !== process.env.EXPECT_HOST || seen("BIND_ADDRESS") !== process.env.EXPECT_BIND_ADDRESS) {
  console.error("got HOST=" + seen("HOST") + " BIND_ADDRESS=" + seen("BIND_ADDRESS"));
  process.exit(3);
}
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(req.url === "/health" ? { ok: true } : { user: "alice" }));
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

const SCENARIO = `name: listen-address
version: 1
steps:
  - id: me
    kind: request
    request: { method: GET, path: /me }
    expect: { status: 200 }
    check: session-survives-switch
`;

/**
 * Twin only connects to instances over 127.0.0.1. An app that reads HOST or
 * BIND_ADDRESS for its listen address gets 127.0.0.1, so it doesn't listen
 * on the network - which on Windows is what brings up the firewall's "allow
 * this app?" prompt. A value the user set anywhere stays theirs.
 */
describe("HOST and BIND_ADDRESS in every instance's environment", () => {
  let projectDir: string;
  const saved = { HOST: process.env.HOST, BIND_ADDRESS: process.env.BIND_ADDRESS };

  beforeEach(async () => {
    // This shell's own environment counts as the user setting them.
    delete process.env.HOST;
    delete process.env.BIND_ADDRESS;
    projectDir = await mkdtemp(path.join(os.tmpdir(), "listen-host-fixture-"));
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "listen-host-fixture", private: true }), "utf8");
    await writeFile(path.join(projectDir, "server.js"), APP, "utf8");
    await writeFile(path.join(projectDir, "scenario.yaml"), SCENARIO, "utf8");
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const run = (env: Record<string, string>): Promise<number> =>
    runCommand(
      {
        projectDir,
        scenarioPath: path.join(projectDir, "scenario.yaml"),
        env,
        start: "node server.js",
        bootTimeoutMs: 30_000,
        keepWorkspaces: false,
        allowRemote: false
      },
      logger
    );

  it("are 127.0.0.1 when nothing set them", async () => {
    expect(await run({ EXPECT_HOST: "127.0.0.1", EXPECT_BIND_ADDRESS: "127.0.0.1" })).toBe(0);
  }, 90_000);

  it("keep a value given with --env or in twin.config.json", async () => {
    expect(await run({ HOST: "localhost", EXPECT_HOST: "localhost", EXPECT_BIND_ADDRESS: "127.0.0.1" })).toBe(0);
  }, 90_000);

  it("count one set in the project's .env as set: Twin adds nothing, so the app's own loading of it wins", async () => {
    await writeFile(path.join(projectDir, ".env"), "HOST=0.0.0.0\n", "utf8");
    // This app doesn't load .env, so it sees no HOST at all - rather than a
    // 127.0.0.1 that would have outranked the file in a dotenv app.
    expect(await run({ EXPECT_HOST: "<unset>", EXPECT_BIND_ADDRESS: "127.0.0.1" })).toBe(0);
  }, 90_000);
});
