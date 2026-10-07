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

  // Regression: suspects used to be ordered by whichever rule happened to be
  // declared first, then capped - so on a real app with several module-level
  // Maps, the express-session suspect (the one that actually explains a
  // session failure) got crowded out of the list entirely.
  it("ranks suspects by the check's declared kind priority, not by rule declaration order", async () => {
    await writeFile(
      path.join(projectDir, "server.js"),
      [
        'const session = require("express-session");', // memory-session-store, line 1
        "const a = new Map();", // module-state, line 2
        "const b = new Map();", // module-state, line 3
        "const c = new Map();", // module-state, line 4
        "let nextId = 1;" // module-state (counter), line 5
      ].join("\n")
    );
    // session-survives-switch declares ["memory-session-store", "module-state"].
    const result = await traceFindings([finding("session-survives-switch", "fail")], projectDir, []);

    expect(result[0]!.suspects[0]).toMatchObject({ kind: "memory-session-store", line: 1 });
    expect(result[0]!.suspects).toHaveLength(3); // still capped
  });

  it("orders a lower-confidence suspect after higher-confidence ones of the same kind", async () => {
    await writeFile(
      path.join(projectDir, "server.js"),
      ["let nextId = 1;", "const notes = new Map();"].join("\n") // low confidence first in file order
    );
    const result = await traceFindings([finding("data-consistency", "fail")], projectDir, []);

    expect(result[0]!.suspects[0]?.confidence).toBe("medium");
    expect(result[0]!.suspects.at(-1)?.confidence).toBe("low");
  });
});
