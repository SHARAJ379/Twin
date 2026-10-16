import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nodeStack } from "../domain/stacks/node.js";
import { findStaticSuspects } from "./findStaticSuspects.js";

describe("findStaticSuspects", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-static-tracer-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("flags a module-level in-memory store, with a project-relative path and 1-indexed line", async () => {
    const file = path.join(projectDir, "server.js");
    await writeFile(file, '// comment\nconst sessions = {};\napp.use(cookieParser());\n');

    const suspects = await findStaticSuspects([file], projectDir, nodeStack.rules);

    const moduleState = suspects.find((s) => s.kind === "module-state");
    expect(moduleState).toMatchObject({ file: "server.js", line: 2, confidence: "medium", source: "static" });
  });

  it("does not flag an indented (non-top-level) empty object", async () => {
    const file = path.join(projectDir, "server.js");
    await writeFile(file, "function f() {\n  const sessions = {};\n}\n");

    const suspects = await findStaticSuspects([file], projectDir, nodeStack.rules);
    expect(suspects.filter((s) => s.kind === "module-state")).toEqual([]);
  });

  it("flags the same line in a CRLF file, trailing comment and all", async () => {
    // A Windows checkout is CRLF (git's core.autocrlf), and a stray `\r` at
    // the end of a line used to defeat every `$`-anchored rule whose line
    // carried a trailing comment - which is most real code. On the fixture
    // this is copied from, that silently cost all four findings their
    // suspects on Windows while passing everywhere else. See sourceLines.ts.
    const file = path.join(projectDir, "server.js");
    await writeFile(file, "// comment\r\nconst sessions = {}; // sessionId -> { email }\r\nconst items = []; // { id, name }\r\n");

    const suspects = await findStaticSuspects([file], projectDir, nodeStack.rules);

    expect(suspects.filter((s) => s.kind === "module-state").map((s) => s.line)).toEqual([2, 3]);
    // The snippet is what the report prints, so it must not carry the `\r`.
    expect(suspects.every((s) => !s.snippet.includes("\r"))).toBe(true);
  });

  it("returns [] for a clean file with no matching patterns", async () => {
    const file = path.join(projectDir, "server.js");
    await writeFile(file, "app.get('/health', (req, res) => res.sendStatus(200));\n");
    expect(await findStaticSuspects([file], projectDir, nodeStack.rules)).toEqual([]);
  });
});
