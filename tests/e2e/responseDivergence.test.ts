import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCommand } from "../../src/cli/commands/run.js";
import { ConsoleLogger } from "../../src/infra/log/consoleLogger.js";

const logger = new ConsoleLogger({ level: "error" });

/**
 * Sessions in a module-level Map, and a logged-out /me that answers 200
 * rather than 401 - a very common pattern, in the shapes ME_SHAPE picks:
 * {"user": null}, {"authenticated": false}, a fallback {"user": "guest"}, or
 * {"user": null} in a body well over the 2KB the report keeps.
 */
const NULL_USER_APP = `
const http = require("node:http");
const crypto = require("node:crypto");
const sessions = new Map();
http.createServer((req, res) => {
  const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
  if (req.url === "/health") return send(200, { ok: true });
  if (req.method === "POST" && req.url === "/login") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const sid = crypto.randomUUID();
      sessions.set(sid, JSON.parse(raw).name);
      send(200, { ok: true }, { "set-cookie": "sid=" + sid + "; Path=/; HttpOnly" });
    });
    return;
  }
  if (req.url === "/me") {
    const user = sessions.get((req.headers.cookie || "").split("sid=")[1]);
    const shape = process.env.ME_SHAPE;
    if (shape === "authenticated") return send(200, { authenticated: user !== undefined });
    if (shape === "guest") return send(200, { user: user ?? "guest" });
    if (shape === "big") return send(200, { user: user ?? null, preferences: "x".repeat(5000) });
    return send(200, { user: user ?? null });
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
    request: { method: POST, path: /login, json: { name: alice } }
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

  it.each([
    ["null", "$.user"],
    ["authenticated", "$.authenticated"],
    ["guest", "$.user"],
    ["big", "$.user"]
  ])("fails the check rather than calling the app safe (/me shape: %s)", async (shape, field) => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "divergence-fixture-"));
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "divergence-fixture", private: true }), "utf8");
    await writeFile(path.join(projectDir, "server.js"), NULL_USER_APP, "utf8");
    await writeFile(path.join(projectDir, "scenario.yaml"), SCENARIO, "utf8");

    const exitCode = await runCommand(
      {
        projectDir,
        scenarioPath: path.join(projectDir, "scenario.yaml"),
        env: { ME_SHAPE: shape },
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
    expect(finding.summary).toContain(field);
    expect(exitCode).toBe(1);
  }, 90_000);
});

/**
 * Sessions done right - a signed cookie, verified with a secret both
 * instances share - plus a per-process cache, whose `cached` flag is true on
 * a single instance (it served the login) and false across instances. That
 * flag differing is the cache working as designed, not lost data.
 */
const SIGNED_SESSION_APP = `
const http = require("node:http");
const crypto = require("node:crypto");
const seen = new Set();
const sign = (name) => name + "." + crypto.createHmac("sha256", process.env.SESSION_SECRET).update(name).digest("hex");
http.createServer((req, res) => {
  const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
  if (req.url === "/health") return send(200, { ok: true });
  if (req.method === "POST" && req.url === "/login") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const name = JSON.parse(raw).name;
      seen.add(name);
      send(200, { ok: true }, { "set-cookie": "sid=" + sign(name) + "; Path=/; HttpOnly" });
    });
    return;
  }
  if (req.url === "/me") {
    const sid = (req.headers.cookie || "").split("sid=")[1] || "";
    const name = sid.slice(0, sid.lastIndexOf("."));
    if (sid !== sign(name)) return send(401, { user: null });
    return send(200, { user: name, cached: seen.has(name), fromCache: seen.has(name), isFirstVisit: !seen.has(name) });
  }
  send(404, {});
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

describe("a flag that legitimately differs per instance", () => {
  let projectDir: string;

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("passes an app whose shared state is correct, though `cached` is true on one instance and false across two", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "cached-flag-fixture-"));
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "cached-flag-fixture", private: true }), "utf8");
    await writeFile(path.join(projectDir, "server.js"), SIGNED_SESSION_APP, "utf8");
    await writeFile(path.join(projectDir, "scenario.yaml"), SCENARIO, "utf8");

    const exitCode = await runCommand(
      {
        projectDir,
        scenarioPath: path.join(projectDir, "scenario.yaml"),
        env: { SESSION_SECRET: "placeholder-secret" },
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
    expect(finding.status, finding.summary).toBe("pass");
    expect(exitCode).toBe(0);
  }, 90_000);
});
