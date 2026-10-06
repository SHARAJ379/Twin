import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Finding } from "../domain/check.js";
import type { WorkspaceDiff } from "../domain/workspaceDiff.js";
import { traceFindings } from "./traceFindings.js";

function finding(checkId: Finding["checkId"], status: Finding["status"]): Finding {
  const base = { checkId, title: checkId, summary: "s", evidence: [], suspects: [] };
  return status === "error" || status === "skipped" ? { ...base, status, reason: "x" } : { ...base, status };
}

describe("traceFindings", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-trace-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("leaves pass/error/skipped findings completely untouched", async () => {
    const findings = [finding("data-consistency", "pass"), finding("data-consistency", "error")];
    const result = await traceFindings(findings, projectDir, []);
    expect(result).toEqual(findings);
  });

  it("is a no-op (skips the scan entirely) when nothing failed", async () => {
    await writeFile(path.join(projectDir, "server.js"), "const sessions = {};\n");
    const findings = [finding("session-survives-switch", "pass")];
    const result = await traceFindings(findings, projectDir, []);
    expect(result[0]!.suspects).toEqual([]);
  });

  it("attaches a static suspect matching the failing check's relevant kind", async () => {
    await writeFile(path.join(projectDir, "server.js"), "const sessions = {};\n");
    const findings = [finding("data-consistency", "fail")];

    const result = await traceFindings(findings, projectDir, []);

    expect(result[0]!.suspects).toHaveLength(1);
    expect(result[0]!.suspects[0]).toMatchObject({ kind: "module-state", confidence: "medium" });
  });

  it("does not attach an irrelevant-kind suspect to a different failing check", async () => {
    await writeFile(path.join(projectDir, "server.js"), 'const sqlite3 = require("better-sqlite3");\n'); // sqlite-file kind
    const findings = [finding("session-survives-switch", "fail")]; // only wants memory-session-store

    const result = await traceFindings(findings, projectDir, []);
    expect(result[0]!.suspects).toEqual([]);
  });

  it("prefers dynamic suspects (high confidence) and lists them before static ones", async () => {
    await writeFile(path.join(projectDir, "server.js"), 'const UPLOAD_DIR = path.join(__dirname, "uploads");\nfs.writeFileSync("x", "y");\n');
    const diff: WorkspaceDiff = { instance: "A", added: [{ path: "uploads/x.png", size: 1, mtimeMs: 1 }], modified: [], removed: [] };
    const findings = [finding("file-consistency", "fail")];

    const result = await traceFindings(findings, projectDir, [diff]);

    expect(result[0]!.suspects[0]?.source).toBe("dynamic");
    expect(result[0]!.suspects[0]?.confidence).toBe("high");
  });

  it("returns the finding unchanged (empty suspects) when nothing matches", async () => {
    await writeFile(path.join(projectDir, "server.js"), "app.get('/health', (req, res) => res.sendStatus(200));\n");
    const findings = [finding("data-consistency", "fail")];
    const result = await traceFindings(findings, projectDir, []);
    expect(result[0]!.suspects).toEqual([]);
  });
});
