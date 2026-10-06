import { readdir } from "node:fs/promises";
import path from "node:path";

const IGNORED_DIRS = new Set(["node_modules", ".git", ".twin", "uploads", "dist", "coverage"]);
const SOURCE_EXTENSIONS = new Set([".js", ".ts", ".mjs", ".cjs"]);

/** Every source file under `projectDir`, excluding noise - the project's own code, not its deps or Twin's own artifacts. */
export async function listSourceFiles(projectDir: string): Promise<string[]> {
  const out: string[] = [];
  await walk(projectDir, out);
  return out;
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await walk(fullPath, out);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(fullPath);
    }
  }
}
