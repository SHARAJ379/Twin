import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { isVirtualenv } from "../stack/virtualenvs.js";

/** Dependencies, build output, VCS metadata and Twin's own artifacts: none of it is the app's own connection code. */
const IGNORED_DIRS = new Set([
  ".git",
  ".twin",
  "node_modules",
  "vendor",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  "dist",
  "build",
  ".next",
  "coverage",
  "uploads",
  "tmp",
  "log",
  // Tests aren't what the app runs, and their fixtures are full of
  // connection strings that look real on purpose.
  "test",
  "tests",
  "__tests__",
  "spec",
  "e2e",
  "fixtures"
]);

/**
 * Test code: `db.test.js`, `db.spec.ts`, `store_test.go`, `test_db.py`. Only
 * ever matched against code, never config - `config/database.test.yml` is
 * what an app loads at runtime, and is scanned like any other config.
 */
const TEST_FILE = /\.(test|spec)\.[^.]+$|_test\.go$|^test_.*\.py$|_spec\.rb$/;

/** A minified bundle or a data dump is not where anyone writes `mongoose.connect(...)`. */
const MAX_FILE_BYTES = 512 * 1024;

/**
 * The project's own source and config, read for the safety preflight's
 * hardcoded-connection-string scan. Runs before the stack is known, so it
 * takes every stack's extensions plus the config formats a connection string
 * is commonly committed in. Unreadable files are skipped: this is a scan for
 * something to refuse on, and a file it can't read can't be refused on.
 */
export async function loadSourceFilesForSafetyScan(
  projectDir: string,
  extensions: readonly string[]
): Promise<{ path: string; content: string }[]> {
  const config = new Set([".json", ".yaml", ".yml", ".toml"]);
  const wanted = new Set([...extensions, ...config]);
  const out: { path: string; content: string }[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // A virtualenv under any name (`.venv-backend`) is installed libraries, not the app.
        if (!IGNORED_DIRS.has(entry.name) && !(await isVirtualenv(fullPath))) await walk(fullPath);
        continue;
      }
      const ext = path.extname(entry.name);
      if (!entry.isFile() || !wanted.has(ext)) continue;
      if (!config.has(ext) && TEST_FILE.test(entry.name)) continue;
      if (entry.name === "package-lock.json") continue;
      try {
        if ((await stat(fullPath)).size > MAX_FILE_BYTES) continue;
        out.push({ path: path.relative(projectDir, fullPath), content: await readFile(fullPath, "utf8") });
      } catch {
        // unreadable - see above
      }
    }
  };

  await walk(projectDir);
  return out;
}
