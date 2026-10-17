import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadSourceFilesForSafetyScan } from "./loadSourceFiles.js";

describe("loadSourceFilesForSafetyScan", () => {
  let dir: string;

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * A test fixture's connection string blocked a run (external audit): tests
   * aren't what the app runs, and their fixtures look real on purpose.
   */
  it("reads the app's code and config, but not its tests or dependencies", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "safety-src-"));
    const files: Record<string, string> = {
      "server.js": "",
      "docker-compose.yml": "",
      "config/default.json": "",
      "test/config.js": "",
      "src/db.test.ts": "",
      "app/store_test.go": "",
      "test_db.py": "",
      "node_modules/pg/index.js": ""
    };
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), content);
    }

    const read = (await loadSourceFilesForSafetyScan(dir, [".js", ".ts", ".go", ".py"])).map((f) => f.path.split(path.sep).join("/"));
    expect(read.sort()).toEqual(["config/default.json", "docker-compose.yml", "server.js"]);
  });
});
