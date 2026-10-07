import { readdir } from "node:fs/promises";
import path from "node:path";

/** Skipped whatever the stack is - Twin's own artifacts, VCS metadata, and upload dumps. */
const ALWAYS_IGNORED = [".git", ".twin", "uploads", "coverage", "node_modules"];

/**
 * Every source file under `projectDir` for the given stack - the project's own
 * code, not its deps or Twin's own artifacts. Extensions and ignored
 * directories come from the stack profile, so a Python project isn't scanned
 * with JavaScript assumptions.
 */
export async function listSourceFiles(
  projectDir: string,
  sourceExtensions: readonly string[],
  ignoreDirs: readonly string[] = []
): Promise<string[]> {
  const extensions = new Set(sourceExtensions);
  const ignored = new Set([...ALWAYS_IGNORED, ...ignoreDirs]);
  const out: string[] = [];
  await walk(projectDir, extensions, ignored, out);
  return out;
}

async function walk(dir: string, extensions: ReadonlySet<string>, ignored: ReadonlySet<string>, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await walk(fullPath, extensions, ignored, out);
      // extname(".env") is "" - a dotfile is all "name", no extension - so an
      // entry like ".env" in sourceExtensions is matched against the name too.
    } else if (entry.isFile() && (extensions.has(path.extname(entry.name)) || extensions.has(entry.name))) {
      out.push(fullPath);
    }
  }
}
