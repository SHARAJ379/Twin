import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Suspect } from "../domain/suspect.js";
import type { SuspectRule } from "../domain/suspectRule.js";

/** Runs every given static rule (§7.6) against every given source file. Rules come from the project's stack profile. */
export async function findStaticSuspects(
  sourceFiles: string[],
  projectDir: string,
  rules: readonly SuspectRule[]
): Promise<Suspect[]> {
  const suspects: Suspect[] = [];

  for (const file of sourceFiles) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue; // vanished or unreadable mid-scan - skip it
    }
    const lines = content.split("\n");
    const relativePath = path.relative(projectDir, file).split(path.sep).join("/");

    for (const rule of rules) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (rule.test(line, content)) {
          suspects.push({
            file: relativePath,
            line: i + 1,
            snippet: line.trim(),
            kind: rule.kind,
            confidence: rule.confidence,
            rationale: rule.rationale,
            source: "static"
          });
        }
      }
    }
  }

  return suspects;
}
