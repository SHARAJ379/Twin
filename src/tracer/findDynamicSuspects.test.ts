import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkspaceDiff } from "../domain/workspaceDiff.js";
import { findDynamicSuspects } from "./findDynamicSuspects.js";

describe("findDynamicSuspects", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-dynamic-tracer-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("finds the source line that references an added file, as high confidence", async () => {
    const serverFile = path.join(projectDir, "server.js");
    await writeFile(serverFile, 'const UPLOAD_DIR = path.join(__dirname, "uploads");\nupload.single("file");\n');

    const diff: WorkspaceDiff = {
      instance: "A",
      added: [{ path: "uploads/x.png", size: 10, mtimeMs: 1 }],
      modified: [],
      removed: []
    };

    const suspects = await findDynamicSuspects(projectDir, diff, [serverFile]);

    expect(suspects).toHaveLength(1);
    expect(suspects[0]).toMatchObject({ file: "server.js", line: 1, confidence: "high", source: "dynamic", kind: "local-fs-write" });
  });

  it("infers sqlite-file kind for a .db path", async () => {
    const serverFile = path.join(projectDir, "server.js");
    await writeFile(serverFile, 'const db = new Database("app.db");\n');

    const diff: WorkspaceDiff = { instance: "A", added: [{ path: "app.db", size: 10, mtimeMs: 1 }], modified: [], removed: [] };
    const suspects = await findDynamicSuspects(projectDir, diff, [serverFile]);

    expect(suspects[0]?.kind).toBe("sqlite-file");
  });

  it("returns [] when the diff has no added/modified files", async () => {
    const diff: WorkspaceDiff = { instance: "A", added: [], modified: [], removed: [{ path: "x", size: 1, mtimeMs: 1 }] };
    expect(await findDynamicSuspects(projectDir, diff, [])).toEqual([]);
  });

  it("returns [] when no source file references the changed path", async () => {
    const serverFile = path.join(projectDir, "server.js");
    await writeFile(serverFile, "console.log('unrelated');\n");
    const diff: WorkspaceDiff = { instance: "A", added: [{ path: "uploads/x.png", size: 1, mtimeMs: 1 }], modified: [], removed: [] };
    expect(await findDynamicSuspects(projectDir, diff, [serverFile])).toEqual([]);
  });
});
