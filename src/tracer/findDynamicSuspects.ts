import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Suspect, SuspectKind } from "../domain/suspect.js";
import type { WorkspaceDiff } from "../domain/workspaceDiff.js";

const SQLITE_EXTENSIONS = new Set([".db", ".sqlite", ".sqlite3"]);

function inferKind(diffPath: string): SuspectKind {
  return SQLITE_EXTENSIONS.has(path.extname(diffPath)) ? "sqlite-file" : "local-fs-write";
}

/**
 * Dynamic evidence (§6.5, §7.6): a file that showed up only on one
 * instance's disk is *direct proof* of local-disk state - find the code
 * that writes that exact path by searching for a literal reference to it.
 * High confidence, because this isn't a guess about what the code might do.
 */
export async function findDynamicSuspects(projectDir: string, diff: WorkspaceDiff, sourceFiles: string[]): Promise<Suspect[]> {
  const changedPaths = [...diff.added, ...diff.modified].map((e) => e.path);
  if (changedPaths.length === 0) return [];

  const suspects: Suspect[] = [];
  const seen = new Set<string>(); // de-dupe (file, line): many uploads can share one containing dir match

  for (const changedPath of changedPaths) {
    const basename = path.basename(changedPath);
    const parentDir = path.dirname(changedPath).split("/").pop();
    const kind = inferKind(changedPath);
    // A generated upload filename (a random UUID, typically) never appears
    // literally in source - only its containing directory does. Try both.
    const candidates = [changedPath, basename, parentDir].filter(
      (c): c is string => c !== undefined && c.length > 0 && c !== "."
    );

    for (const file of sourceFiles) {
      let content: string;
      try {
        content = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      const relativePath = path.relative(projectDir, file).split(path.sep).join("/");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const key = `${relativePath}:${i + 1}`;
        if (!seen.has(key) && candidates.some((c) => line.includes(c))) {
          seen.add(key);
          suspects.push({
            file: relativePath,
            line: i + 1,
            snippet: line.trim(),
            kind,
            confidence: "high",
            rationale: `"${changedPath}" was written only on instance ${diff.instance}'s local disk, and this line references it`,
            source: "dynamic"
          });
        }
      }
    }
  }

  return suspects;
}
