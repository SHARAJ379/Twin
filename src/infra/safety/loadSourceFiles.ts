import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

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
  "log"
]);

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
  const wanted = new Set([...extensions, ".json", ".yaml", ".yml", ".toml"]);
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
        if (!IGNORED_DIRS.has(entry.name)) await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !wanted.has(path.extname(entry.name)) || entry.name.endsWith(".lock.json")) continue;
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
