import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Finding } from "../domain/check.js";
import type { StepResult } from "../domain/stepResult.js";
import type { WorkspaceDiff } from "../domain/workspaceDiff.js";
import { nodeStack } from "../domain/stacks/node.js";
import { traceFindings } from "./traceFindings.js";

function stepResult(stepId: string, requestPath: string): StepResult {
  return {
    stepId,
    startedAt: 0,
    durationMs: 1,
    expectationsPassed: false,
    failedExpectations: ["expected status 200, got 404"],
    request: { method: "GET", path: requestPath, headers: {} }
  };
}

/** A failing finding that points at one split-run step, the way the control gate builds it. */
function findingForStep(checkId: Finding["checkId"], stepId: string): Finding {
  return {
    checkId,
    status: "fail",
    title: checkId,
    summary: "s",
    evidence: [{ run: "split", stepId }],
    suspects: []
  };
}

function finding(checkId: Finding["checkId"], status: Finding["status"], blockedBy?: "auth"): Finding {
  const base = {
    checkId,
    title: checkId,
    summary: "s",
    evidence: [],
    suspects: [],
    ...(blockedBy === undefined ? {} : { blockedBy })
  };
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
    const result = await traceFindings(findings, projectDir, [], nodeStack);
    expect(result).toEqual(findings);
  });

  it("is a no-op (skips the scan entirely) when nothing failed", async () => {
    await writeFile(path.join(projectDir, "server.js"), "const sessions = {};\n");
    const findings = [finding("session-survives-switch", "pass")];
    const result = await traceFindings(findings, projectDir, [], nodeStack);
    expect(result[0]!.suspects).toEqual([]);
  });

  // An untagged step that diverged (evaluate.ts) is a fail like any check's,
  // and gets suspects the same way - not the empty list an unknown id gets.
  it("attaches suspects to an instance-divergence failure", async () => {
    await writeFile(path.join(projectDir, "server.js"), "const items = [];\n");

    const result = await traceFindings([finding("instance-divergence", "fail")], projectDir, [], nodeStack);

    expect(result[0]!.suspects[0]).toMatchObject({ kind: "module-state" });
  });

  it("attaches a static suspect matching the failing check's relevant kind", async () => {
    await writeFile(path.join(projectDir, "server.js"), "const sessions = {};\n");
    const findings = [finding("data-consistency", "fail")];

    const result = await traceFindings(findings, projectDir, [], nodeStack);

    expect(result[0]!.suspects).toHaveLength(1);
    expect(result[0]!.suspects[0]).toMatchObject({ kind: "module-state", confidence: "medium" });
  });

  it("does not attach an irrelevant-kind suspect to a different failing check", async () => {
    await writeFile(path.join(projectDir, "server.js"), 'const sqlite3 = require("better-sqlite3");\n'); // sqlite-file kind
    const findings = [finding("session-survives-switch", "fail")]; // only wants memory-session-store

    const result = await traceFindings(findings, projectDir, [], nodeStack);
    expect(result[0]!.suspects).toEqual([]);
  });

  it("prefers dynamic suspects (high confidence) and lists them before static ones", async () => {
    await writeFile(path.join(projectDir, "server.js"), 'const UPLOAD_DIR = path.join(__dirname, "uploads");\nfs.writeFileSync("x", "y");\n');
    const diff: WorkspaceDiff = { instance: "A", added: [{ path: "uploads/x.png", size: 1, mtimeMs: 1 }], modified: [], removed: [] };
    const findings = [finding("file-consistency", "fail")];

    const result = await traceFindings(findings, projectDir, [diff], nodeStack);

    expect(result[0]!.suspects[0]?.source).toBe("dynamic");
    expect(result[0]!.suspects[0]?.confidence).toBe("high");
  });

  it("returns the finding unchanged (empty suspects) when nothing matches", async () => {
    await writeFile(path.join(projectDir, "server.js"), "app.get('/health', (req, res) => res.sendStatus(200));\n");
    const findings = [finding("data-consistency", "fail")];
    const result = await traceFindings(findings, projectDir, [], nodeStack);
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
        // Session-named, so a session failure may name them (see below).
        "const sessions = new Map();", // module-state, line 2
        "const tokens = new Map();", // module-state, line 3
        "const loginAttempts = new Map();", // module-state, line 4
        "let sessionCount = 1;" // module-state (counter), line 5
      ].join("\n")
    );
    // session-survives-switch declares ["memory-session-store", "module-state"].
    const result = await traceFindings([finding("session-survives-switch", "fail")], projectDir, [], nodeStack);

    expect(result[0]!.suspects[0]).toMatchObject({ kind: "memory-session-store", line: 1 });
    expect(result[0]!.suspects).toHaveLength(3); // still capped
  });

  // Found by testing the packed tarball: a Flask session failure was blamed on
  // `items = {}`. A session failure names session-specific code or nothing.
  it("never names a plain data container for a session failure, even when nothing else matches", async () => {
    await writeFile(path.join(projectDir, "server.js"), ["const items = [];", "const notes = new Map(); let nextId = 1;"].join("\n"));

    const [session, data] = await traceFindings(
      [finding("session-survives-switch", "fail"), finding("data-consistency", "fail")],
      projectDir,
      [],
      nodeStack
    );

    expect(session!.suspects).toEqual([]); // no confident suspect
    expect(data!.suspects.map((s) => s.snippet)).toContain("const notes = new Map(); let nextId = 1;");
  });

  it("lists a line once even when two rules match it", async () => {
    // The multer rule and the fs-write rule both match this one line.
    await writeFile(
      path.join(projectDir, "server.js"),
      'const upload = multer({ dest: "uploads/" }); fs.writeFileSync(path.join(__dirname, "x.json"), body);'
    );

    const [file] = await traceFindings([finding("file-consistency", "fail")], projectDir, [], nodeStack);

    expect(file!.suspects.map((s) => `${s.file}:${s.line}`)).toEqual(["server.js:1"]);
  });

  it("names a local file write for a session failure only when it writes sessions", async () => {
    await writeFile(
      path.join(projectDir, "server.js"),
      [
        'fs.writeFileSync(path.join(__dirname, "data.json"), body);', // records, line 1
        'fs.writeFileSync(path.join(__dirname, "sessions", sid + ".json"), body);' // sessions, line 2
      ].join("\n")
    );

    const [session] = await traceFindings([finding("session-survives-switch", "fail")], projectDir, [], nodeStack);

    expect(session!.suspects.map((s) => s.line)).toEqual([2]);
  });

  it("names a session-named container for a session failure, ahead of nothing else", async () => {
    await writeFile(path.join(projectDir, "server.js"), ["const items = [];", "const sessions = {}; // sessionId -> user"].join("\n"));

    const [session] = await traceFindings([finding("session-survives-switch", "fail")], projectDir, [], nodeStack);

    expect(session!.suspects.map((s) => s.line)).toEqual([2]);
  });

  it("orders a lower-confidence suspect after higher-confidence ones of the same kind", async () => {
    await writeFile(
      path.join(projectDir, "server.js"),
      ["let nextId = 1;", "const notes = new Map();"].join("\n") // low confidence first in file order
    );
    const result = await traceFindings([finding("data-consistency", "fail")], projectDir, [], nodeStack);

    expect(result[0]!.suspects[0]?.confidence).toBe("medium");
    expect(result[0]!.suspects.at(-1)?.confidence).toBe("low");
  });

  // Regression: a workspace diff is proof about the file it came from, not
  // about whichever check happens to be failing. Ranking dynamic-before-static
  // ahead of kind relevance let the upload directory lead data-consistency's
  // suspects and push the in-memory record store the check is actually about
  // off the end of the 3-suspect cap.
  it("ranks the check's most relevant kind ahead of a dynamic suspect of a less relevant kind", async () => {
    await writeFile(
      path.join(projectDir, "server.js"),
      [
        'const UPLOAD_DIR = path.join(__dirname, "uploads");', // local-fs-write, dynamic match, line 1
        "const items = new Map();" // module-state - what data-consistency is about, line 2
      ].join("\n")
    );
    const diff: WorkspaceDiff = { instance: "A", added: [{ path: "uploads/x.png", size: 1, mtimeMs: 1 }], modified: [], removed: [] };

    const result = await traceFindings([finding("data-consistency", "fail")], projectDir, [diff], nodeStack);

    // data-consistency declares ["module-state", "sqlite-file", "local-fs-write"].
    expect(result[0]!.suspects[0]).toMatchObject({ kind: "module-state", line: 2 });
    // The dynamic upload evidence is still listed - just not as the headline.
    expect(result[0]!.suspects.some((suspect) => suspect.source === "dynamic")).toBe(true);
  });

  it("still puts dynamic evidence first among suspects of equally relevant kind", async () => {
    await writeFile(
      path.join(projectDir, "server.js"),
      ['fs.writeFileSync("x", "y");', 'const UPLOAD_DIR = path.join(__dirname, "uploads");'].join("\n")
    );
    const diff: WorkspaceDiff = { instance: "A", added: [{ path: "uploads/x.png", size: 1, mtimeMs: 1 }], modified: [], removed: [] };

    const result = await traceFindings([finding("file-consistency", "fail")], projectDir, [diff], nodeStack);

    expect(result[0]!.suspects[0]).toMatchObject({ source: "dynamic", confidence: "high" });
  });

  // Regression: all four checks failed with a 401 on examples/broken-express,
  // because the session died first - and three of them were handed the upload
  // directory as a high-confidence cause for a request no handler ever saw.
  it("blames the session layer for an auth-blocked finding, whatever check it belongs to", async () => {
    await writeFile(
      path.join(projectDir, "server.js"),
      [
        "const sessions = {};", // memory-session-store, line 1
        'const UPLOAD_DIR = path.join(__dirname, "uploads");' // local-fs-write, line 2
      ].join("\n")
    );
    const diff: WorkspaceDiff = { instance: "A", added: [{ path: "uploads/x.png", size: 1, mtimeMs: 1 }], modified: [], removed: [] };

    const result = await traceFindings([finding("file-consistency", "fail", "auth")], projectDir, [diff], nodeStack);

    expect(result[0]!.suspects).toHaveLength(1);
    // A bare module-level object is the session store here - which is why
    // "module-state" counts as session evidence and not just data evidence.
    expect(result[0]!.suspects[0]).toMatchObject({ kind: "module-state", line: 1 });
    // The upload path is exactly what it must no longer offer here.
    expect(result[0]!.suspects.some((suspect) => suspect.line === 2)).toBe(false);
  });

  // Regression: an app that keeps its records AND its uploads on local disk
  // produces the same three local-fs-write suspects for both file-backed
  // checks, so file-consistency's headline cause was whichever one came first
  // in the file - the record store - rather than the upload it asked for.
  describe("two checks sharing one set of local-disk suspects", () => {
    const diff: WorkspaceDiff = {
      instance: "A",
      added: [{ path: "uploads/twin-test-4f2a.txt", size: 1, mtimeMs: 1 }],
      modified: [{ path: "data.json", size: 2, mtimeMs: 2 }],
      removed: []
    };

    beforeEach(async () => {
      await writeFile(
        path.join(projectDir, "server.js"),
        [
          'const DATA_FILE = path.join(__dirname, "data.json");', // line 1
          'const UPLOAD_DIR = path.join(__dirname, "uploads");' // line 2
        ].join("\n")
      );
    });

    it("leads with the upload for the check whose request asked for that file", async () => {
      const split = [stepResult("read-file", "/uploads/twin-test-4f2a.txt")];

      const result = await traceFindings(
        [findingForStep("file-consistency", "read-file")],
        projectDir,
        [diff],
        nodeStack,
        split
      );

      expect(result[0]!.suspects[0]).toMatchObject({ line: 2, evidencePath: "uploads/twin-test-4f2a.txt" });
    });

    it("leads with the record store for the check whose request named no file at all", async () => {
      const split = [stepResult("read-item", "/items/3")];

      const result = await traceFindings(
        [findingForStep("data-consistency", "read-item")],
        projectDir,
        [diff],
        nodeStack,
        split
      );

      expect(result[0]!.suspects[0]).toMatchObject({ line: 1, evidencePath: "data.json" });
    });

    // Both remain real local-disk state in a broken app, so neither is dropped
    // from the other's list - only ordered behind the one that explains it.
    it("still offers the other suspects, just not as the headline", async () => {
      const split = [stepResult("read-file", "/uploads/twin-test-4f2a.txt")];

      const result = await traceFindings(
        [findingForStep("file-consistency", "read-file")],
        projectDir,
        [diff],
        nodeStack,
        split
      );

      expect(result[0]!.suspects.map((suspect) => suspect.line)).toEqual([2, 1]);
    });

    it("falls back to the old order when no split results are passed at all", async () => {
      const result = await traceFindings([findingForStep("file-consistency", "read-file")], projectDir, [diff], nodeStack);

      expect(result[0]!.suspects.map((suspect) => suspect.line)).toEqual([1, 2]);
    });
  });
});
