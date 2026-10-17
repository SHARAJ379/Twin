import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCommand } from "../../src/cli/commands/run.js";
import type { Logger } from "../../src/ports/logger.js";

const salts = vi.hoisted(() => [] as Buffer[]);
vi.mock("../../src/infra/http/fingerprintSalt.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/infra/http/fingerprintSalt.js")>();
  return {
    ...original,
    newFingerprintSalt: () => {
      const salt = original.newFingerprintSalt();
      salts.push(salt);
      return salt;
    }
  };
});

const APP = `
const http = require("node:http");
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(req.url === "/health" ? { ok: true } : { user: "alice", note: "hello world" }));
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

const SCENARIO = `name: salt
version: 1
steps:
  - id: write
    kind: request
    via: A
    request: { method: POST, path: /items, json: { name: alice } }
    expect: { status: 200 }
  - id: read
    kind: request
    via: B
    request: { method: GET, path: /me }
    expect: { status: 200 }
    check: session-survives-switch
`;

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
}

/**
 * The fingerprint salt is what keeps a hashed short password in results.json
 * from being a dictionary lookup. That only holds while the salt never leaves
 * the process: not in any artifact, log or terminal line, under any encoding.
 */
describe("the response-fingerprint salt", () => {
  let projectDir: string;

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("is never written anywhere a run leaves behind, and is fresh per run", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "salt-fixture-"));
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "salt-fixture", private: true }), "utf8");
    await writeFile(path.join(projectDir, "server.js"), APP, "utf8");
    await writeFile(path.join(projectDir, "scenario.yaml"), SCENARIO, "utf8");

    const printed: string[] = [];
    const record = (message: string, meta?: Record<string, unknown>): void => {
      printed.push(message, JSON.stringify(meta ?? {}));
    };
    const logger: Logger = { debug: record, info: record, warn: record, error: record, child: () => logger };
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      printed.push(String(chunk));
      return true;
    });

    const options = {
      projectDir,
      scenarioPath: path.join(projectDir, "scenario.yaml"),
      env: {},
      start: "node server.js",
      healthPath: "/health",
      portEnv: "PORT",
      bootTimeoutMs: 30_000,
      keepWorkspaces: false,
      allowRemote: false
    };
    try {
      expect(await runCommand(options, logger)).toBe(0);
      expect(await runCommand(options, logger)).toBe(0);
    } finally {
      stdout.mockRestore();
    }

    // One salt per run, shared by its control and split runs.
    expect(salts).toHaveLength(2);
    expect(salts[0]!.equals(salts[1]!)).toBe(false);

    const files = await filesUnder(path.join(projectDir, ".twin"));
    expect(files.some((f) => f.endsWith("results.json"))).toBe(true);
    expect(files.some((f) => f.endsWith("report.json"))).toBe(true);
    expect(files.some((f) => f.endsWith(".log"))).toBe(true);

    const output = printed.join("\n");
    for (const salt of salts) {
      const forms = [salt.toString("hex"), salt.toString("hex").toUpperCase(), salt.toString("base64"), salt.toString("base64url")];
      for (const file of files) {
        const bytes = await readFile(file);
        expect(bytes.indexOf(salt), file).toBe(-1);
        const text = bytes.toString("utf8");
        for (const form of forms) expect(text.includes(form), `${file} contains the salt`).toBe(false);
      }
      for (const form of forms) expect(output.includes(form), "terminal/log output contains the salt").toBe(false);
    }

    // And the fingerprints really are salted: "alice" was sent, so its hash is recorded.
    const latest = await readFile(path.join(projectDir, ".twin", "latest"), "utf8");
    const results = await readFile(path.join(projectDir, ".twin", "runs", latest, "results.json"), "utf8");
    const { createHash } = await import("node:crypto");
    const unsalted = createHash("sha256").update("alice").digest("hex").slice(0, 16);
    const salted = createHash("sha256").update(salts[1]!).update("alice").digest("hex").slice(0, 16);
    expect(results).toContain(salted);
    expect(results).not.toContain(unsalted);
  }, 120_000);
});
