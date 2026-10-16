import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { parse } from "dotenv";

/**
 * Suffix words that mark a file nothing ever loads: it exists to be copied and
 * filled in. `.env.example` and friends are committed, so they hold the
 * placeholder values a real `.env` replaces - scanning them produces false
 * positives (a template's `db.example.com`) and, before the scan stopped
 * merging, let a placeholder mask the real value sitting next to it.
 *
 * `.env.defaults` is deliberately absent: dotenv-flow really does load it, so
 * a remote host hiding there would reach the app.
 */
const PLACEHOLDER_SEGMENTS = new Set(["example", "sample", "template", "dist", "skeleton", "tpl"]);

function isPlaceholderEnvFile(name: string): boolean {
  return name
    .slice(".env".length)
    .split(".")
    .some((segment) => PLACEHOLDER_SEGMENTS.has(segment.toLowerCase()));
}

export interface DotEnvFile {
  /** The file's own name, so a refusal can name the place to go and fix it. */
  name: string;
  vars: Record<string, string>;
}

/**
 * Parses each `.env*` file in `projectDir` (not recursive) for the safety scan
 * (§9.1) - Twin never injects these into its own process.env or an instance's
 * env; the app loads its own `.env` itself.
 *
 * Each file is returned separately, and that matters. These used to be merged
 * into one map with later files overwriting earlier ones, which turned the
 * safety check into something a committed template could switch off: a real
 * `DATABASE_URL=postgres://...prod...` in `.env` and a `localhost` placeholder
 * in `.env.example` merged to localhost, the scan saw nothing remote, and Twin
 * would write test traffic into the production database. A scan has no business
 * picking one value per key anyway - it has to look at every value any file
 * declares, because any of them might be the one the app loads.
 */
export async function loadDotEnvFiles(projectDir: string): Promise<DotEnvFile[]> {
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return [];
  }

  const envFiles = entries
    .filter((name) => name === ".env" || name.startsWith(".env."))
    .filter((name) => !isPlaceholderEnvFile(name))
    .sort();

  const files: DotEnvFile[] = [];
  for (const name of envFiles) {
    try {
      const contents = await readFile(path.join(projectDir, name), "utf8");
      files.push({ name, vars: parse(contents) });
    } catch {
      // Unreadable or malformed - skip it rather than fail the whole scan over one bad file.
    }
  }

  return files;
}
