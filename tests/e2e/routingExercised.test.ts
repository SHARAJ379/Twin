import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCommand, type RunOptions } from "../../src/cli/commands/run.js";
import { ConsoleLogger } from "../../src/infra/log/consoleLogger.js";

const logger = new ConsoleLogger({ level: "error" });

/** Keeps items in a module-level Map: broken the moment there are two instances. */
const IN_MEMORY_APP = `
const http = require("node:http");
const items = new Map();
let next = 1;
http.createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.method === "GET" && req.url === "/health") return send(200, { ok: true });
  if (req.method === "POST" && req.url === "/items") {
    const id = String(next++);
    items.set(id, { id, name: "test-item" });
    return send(201, items.get(id));
  }
  const id = req.url.startsWith("/items/") ? req.url.slice("/items/".length) : undefined;
  if (req.method === "GET" && id !== undefined) return items.has(id) ? send(200, items.get(id)) : send(404, {});
  send(404, {});
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

const scenario = (readVia: string): string => `name: create-noise-read
version: 1
steps:
  - id: create
    kind: request
    request: { method: POST, path: /items }
    expect: { status: 201 }
    save: { itemId: "$.id" }
  - id: noise
    kind: request
    request: { method: GET, path: /health }
    expect: { status: 200 }
  - id: read
    kind: request
${readVia}    request: { method: GET, path: "/items/{{itemId}}" }
    expect: { status: 200 }
    check: data-consistency
`;

const baseOptions: Omit<RunOptions, "projectDir" | "scenarioPath" | "env"> = {
  start: "node server.js",
  healthPath: "/health",
  portEnv: "PORT",
  bootTimeoutMs: 30_000,
  keepWorkspaces: false,
  allowRemote: false
};

/**
 * Reported by an external audit: create, one unrelated GET, read back, with
 * no `via:` anywhere. Round-robin routed them A, B, A - so the read came from
 * the instance that did the write, an in-memory app passed data-consistency,
 * and Twin said it looked safe to run on more than one instance.
 */
describe("a check whose routing never crossed an instance", () => {
  let projectDir: string;

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function run(readVia: string): Promise<{ exitCode: number; finding: { status: string; summary: string } }> {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "routing-fixture-"));
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "routing-fixture", private: true }), "utf8");
    await writeFile(path.join(projectDir, "server.js"), IN_MEMORY_APP, "utf8");
    await writeFile(path.join(projectDir, "scenario.yaml"), scenario(readVia), "utf8");

    const exitCode = await runCommand(
      { ...baseOptions, projectDir, scenarioPath: path.join(projectDir, "scenario.yaml"), env: {} },
      logger
    );
    const twinDir = path.join(projectDir, ".twin");
    const latestId = await readFile(path.join(twinDir, "latest"), "utf8");
    const report = JSON.parse(await readFile(path.join(twinDir, "runs", latestId, "report.json"), "utf8")) as {
      findings: { checkId: string; status: string; summary: string }[];
    };
    return { exitCode, finding: report.findings.find((f) => f.checkId === "data-consistency")! };
  }

  it("routes an unpinned check step to the other instance, and so catches the bug", async () => {
    const { exitCode, finding } = await run("");
    expect(finding.status).toBe("fail");
    expect(exitCode).toBe(1);
  }, 90_000);

  it("never calls a read that stayed on the writing instance a pass", async () => {
    // `via: any` is an explicit choice, so it isn't rerouted - and with the
    // noise step in between, round-robin lands it back on the writer.
    const { exitCode, finding } = await run("    via: any\n");
    expect(finding.status).toBe("error");
    expect(finding.summary).toContain("same instance as the write");
    expect(exitCode).not.toBe(0);
  }, 90_000);
});
