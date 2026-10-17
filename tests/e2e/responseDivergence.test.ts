import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCommand } from "../../src/cli/commands/run.js";
import { ConsoleLogger } from "../../src/infra/log/consoleLogger.js";

const logger = new ConsoleLogger({ level: "error" });

/**
 * Sessions in a module-level Map, and a logged-out /me that answers
 * 200 {"user": null} rather than 401 - a very common pattern.
 */
const NULL_USER_APP = `
const http = require("node:http");
const crypto = require("node:crypto");
const sessions = new Map();
http.createServer((req, res) => {
  const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
  if (req.url === "/health") return send(200, { ok: true });
  if (req.method === "POST" && req.url === "/login") {
    const sid = crypto.randomUUID();
    sessions.set(sid, "alice");
    return send(200, { ok: true }, { "set-cookie": "sid=" + sid + "; Path=/; HttpOnly" });
  }
  if (req.url === "/me") {
    const sid = (req.headers.cookie || "").split("sid=")[1];
    return send(200, { user: sessions.get(sid) ?? null });
  }
  send(404, {});
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

// The README's own shape: me-check expects only a 200.
const SCENARIO = `name: login-then-me
version: 1
steps:
  - id: login
    kind: request
    request: { method: POST, path: /login }
    expect: { status: 200 }
  - id: me-check
    kind: request
    request: { method: GET, path: /me }
    expect: { status: 200 }
    check: session-survives-switch
`;

/**
 * Reported by an external audit: control returned {"user":"alice"}, the split
 * run {"user":null}, both were in results.json - and Twin reported
 * session-survives-switch PASS, "looks safe", exit 0, because it only ever
 * consulted the scenario's own expect:.
 */
describe("a split response that passes expect: but lost data", () => {
  let projectDir: string;

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("fails the check rather than calling the app safe", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "divergence-fixture-"));
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "divergence-fixture", private: true }), "utf8");
    await writeFile(path.join(projectDir, "server.js"), NULL_USER_APP, "utf8");
    await writeFile(path.join(projectDir, "scenario.yaml"), SCENARIO, "utf8");

    const exitCode = await runCommand(
      {
        projectDir,
        scenarioPath: path.join(projectDir, "scenario.yaml"),
        env: {},
        start: "node server.js",
        healthPath: "/health",
        portEnv: "PORT",
        bootTimeoutMs: 30_000,
        keepWorkspaces: false,
        allowRemote: false
      },
      logger
    );

    const twinDir = path.join(projectDir, ".twin");
    const latestId = await readFile(path.join(twinDir, "latest"), "utf8");
    const report = JSON.parse(await readFile(path.join(twinDir, "runs", latestId, "report.json"), "utf8")) as {
      findings: { checkId: string; status: string; summary: string }[];
    };
    const finding = report.findings.find((f) => f.checkId === "session-survives-switch")!;
    expect(finding.status).toBe("fail");
    expect(finding.summary).toContain("$.user");
    expect(exitCode).toBe(1);
  }, 90_000);
});
