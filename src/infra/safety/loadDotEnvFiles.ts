import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { parse } from "dotenv";

/**
 * Parses every `.env*` file in `projectDir` (not recursive) into one merged
 * map, for the safety scan only (§9.1) - Twin never injects these into its
 * own process.env or an instance's env; the app loads its own `.env` itself.
 */
export async function loadDotEnvFiles(projectDir: string): Promise<Record<string, string>> {
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return {};
  }

  const envFiles = entries.filter((name) => name === ".env" || name.startsWith(".env."));
  const merged: Record<string, string> = {};

  for (const name of envFiles) {
    try {
      const contents = await readFile(path.join(projectDir, name), "utf8");
      Object.assign(merged, parse(contents));
    } catch {
      // Unreadable or malformed - skip it rather than fail the whole scan over one bad file.
    }
  }

  return merged;
}
