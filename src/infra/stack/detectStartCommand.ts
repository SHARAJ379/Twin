import { readFile } from "node:fs/promises";
import path from "node:path";

import { TwinError } from "../../domain/errors.js";

/** Scripts that exist for reasons other than "this boots the app" - never guessed as a start command. */
const NON_START_SCRIPTS = new Set([
  "test",
  "lint",
  "build",
  "depcheck",
  "verify",
  "prepare",
  "preinstall",
  "postinstall",
  "pretest",
  "posttest",
  "typecheck",
  "format",
  "clean"
]);

/** Checked in order; the first one present in package.json's scripts wins. */
const PRIORITY_SCRIPTS = ["start", "dev", "serve"];

const HINT = 'Pass --start "<command>" explicitly, or set "start" in twin.config.json (see `twin init`).';

/**
 * Guesses how to boot the app from package.json's scripts (§16, E_NO_STACK/E_AMBIGUOUS_STACK).
 * Only used when neither --start nor twin.config.json's "start" was given.
 */
export async function detectStartCommand(projectDir: string): Promise<string> {
  const pkgPath = path.join(projectDir, "package.json");
  let scripts: Record<string, unknown>;
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { scripts?: Record<string, unknown> };
    scripts = pkg.scripts ?? {};
  } catch (err) {
    throw new TwinError("E_NO_STACK", `could not find a package.json in "${projectDir}" to detect a start command`, {
      hint: HINT,
      cause: err
    });
  }

  for (const name of PRIORITY_SCRIPTS) {
    if (typeof scripts[name] === "string") {
      return name === "start" ? "npm start" : `npm run ${name}`;
    }
  }

  const candidates = Object.keys(scripts).filter((name) => typeof scripts[name] === "string" && !NON_START_SCRIPTS.has(name));
  if (candidates.length === 1) return `npm run ${candidates[0]}`;

  if (candidates.length === 0) {
    throw new TwinError("E_NO_STACK", `package.json in "${projectDir}" has no start-like script`, { hint: HINT });
  }

  throw new TwinError(
    "E_AMBIGUOUS_STACK",
    `could not tell which package.json script starts the app - found ${candidates.length} candidates: ${candidates.join(", ")}`,
    { hint: HINT, details: { candidates } }
  );
}
