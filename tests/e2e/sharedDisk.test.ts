import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCommand } from "../../src/cli/commands/run.js";
import { ConsoleLogger } from "../../src/infra/log/consoleLogger.js";

const logger = new ConsoleLogger({ level: "error" });

/**
 * Items kept in one JSON file: ITEMS_FILE if set, otherwise a path hardcoded
 * into the app (HARDCODED, substituted below). Correct on one server; on two,
 * each has its own file.
 */
const APP = `
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const FILE = process.env.ITEMS_FILE || HARDCODED;
fs.mkdirSync(path.dirname(FILE), { recursive: true });
const read = () => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return []; } };
http.createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/health") return send(200, { ok: true });
  if (req.method === "POST" && req.url === "/items") {
    const items = read();
    const item = { id: String(items.length + 1) + "-" + Date.now(), name: "test-item" };
    items.push(item);
    fs.writeFileSync(FILE, JSON.stringify(items));
    return send(201, item);
  }
  if (req.url.startsWith("/items/")) {
    const item = read().find((i) => i.id === req.url.slice(7));
    return item ? send(200, item) : send(404, {});
  }
  send(404, {});
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

const SCENARIO = `name: items
version: 1
steps:
  - id: create-item
    kind: request
    via: A
    request: { method: POST, path: /items }
    expect: { status: 201 }
    save: { itemId: "$.id" }
  - id: read-item-other-instance
    kind: request
    via: B
    request: { method: GET, path: "/items/{{itemId}}" }
    expect: { status: 200, bodyContains: "test-item" }
    check: data-consistency
`;

interface Report {
  verdict: { passed: number; errored: number; safeForMultiInstance: boolean };
  findings: { checkId: string; status: string; summary: string; unprovenBy?: string }[];
}

/**
 * Found by an external audit: A and B run on one machine, so an app keeping
 * its data in `/tmp/twin-demo-items.json` passed data-consistency - "safe to
 * run on more than one instance", exit 0 - and broke the moment it ran on two
 * servers. Shared storage that really is shared (`{{shared}}`, "sharedPaths")
 * must still pass.
 */
describe("a store that is only shared because both instances are on one disk", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    for (const p of cleanup.splice(0)) await rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function runApp(hardcoded: string, config: object, env: Record<string, string> = {}): Promise<{ exitCode: number; report: Report }> {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "shared-disk-fixture-"));
    cleanup.push(projectDir);
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "shared-disk-fixture", private: true }), "utf8");
    await writeFile(path.join(projectDir, "server.js"), APP.replace("HARDCODED", JSON.stringify(hardcoded)), "utf8");
    await writeFile(path.join(projectDir, "scenario.yaml"), SCENARIO, "utf8");
    await writeFile(path.join(projectDir, "twin.config.json"), JSON.stringify({ scenario: "scenario.yaml", ...config }), "utf8");

    const exitCode = await runCommand(
      { projectDir, env, start: "node server.js", bootTimeoutMs: 30_000, keepWorkspaces: false, allowRemote: false },
      logger
    );
    const latest = await readFile(path.join(projectDir, ".twin", "latest"), "utf8");
    const report = JSON.parse(await readFile(path.join(projectDir, ".twin", "runs", latest, "report.json"), "utf8")) as Report;
    return { exitCode, report };
  }

  it("does not call an app storing items in /tmp/twin-demo-items.json safe", async () => {
    // The audit's own path, made unique so parallel runs can't share it.
    const file = `/tmp/twin-demo-items-${randomUUID()}.json`;
    // Where the app's "/tmp" lands: on Windows, the workspace's drive.
    cleanup.push(path.join(path.parse(os.tmpdir()).root, file));

    const { exitCode, report } = await runApp(file, {});

    const finding = report.findings.find((f) => f.checkId === "data-consistency")!;
    expect(finding).toMatchObject({ status: "error", unprovenBy: "shared-local-disk" });
    expect(finding.summary).toContain("twin-demo-items-");
    expect(report.verdict.safeForMultiInstance).toBe(false);
    expect(exitCode).not.toBe(0);
    expect(exitCode).toBe(2);
  }, 90_000);

  it("does not call an app storing items at an absolute DATA path from the env safe", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "shared-disk-data-"));
    cleanup.push(dir);

    const { exitCode, report } = await runApp("unused.json", {}, { ITEMS_FILE: path.join(dir, "items.json") });

    expect(report.findings.find((f) => f.checkId === "data-consistency")).toMatchObject({ unprovenBy: "shared-local-disk" });
    expect(exitCode).toBe(2);
  }, 90_000);

  it("passes the same app pointed at {{shared}}, the run's stand-in for a shared volume", async () => {
    const { exitCode, report } = await runApp("unused.json", { env: { ITEMS_FILE: "{{shared}}/items.json" } });

    expect(report.findings.find((f) => f.checkId === "data-consistency")?.status).toBe("pass");
    expect(exitCode).toBe(0);
  }, 90_000);

  it("passes a path declared as shared storage in sharedPaths", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "shared-disk-volume-"));
    cleanup.push(dir);

    const { exitCode } = await runApp("unused.json", { sharedPaths: [dir] }, { ITEMS_FILE: path.join(dir, "items.json") });
    expect(exitCode).toBe(0);
  }, 90_000);
});
