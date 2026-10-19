import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { TwinError } from "../../domain/errors.js";
import type { StackId, StackProfile } from "../../domain/stack.js";
import { matchingStacks, stackIds, stackProfile } from "../../domain/stacks/index.js";

export interface DetectedStack {
  profile: StackProfile;
  /** undefined when the stack was identified but no start command could be guessed. */
  startCommand: string | undefined;
}

async function readProjectEntries(projectDir: string): Promise<string[]> {
  try {
    return await readdir(projectDir);
  } catch (err) {
    throw new TwinError("E_NO_STACK", `could not read the project directory "${projectDir}"`, {
      hint: "Check the --project path.",
      cause: err
    });
  }
}

async function readMarkerFiles(projectDir: string, names: readonly string[]): Promise<Record<string, string>> {
  const entries = await Promise.all(
    names.map(async (name) => {
      try {
        return [name, await readFile(path.join(projectDir, name), "utf8")] as const;
      } catch {
        return undefined; // not present - resolveStartCommand decides what that means
      }
    })
  );
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry !== undefined));
}

/** Never an app of their own: dependencies, VCS metadata, Twin's artifacts. */
const NOT_A_SUBPROJECT = new Set(["node_modules", "vendor", "venv", "env"]);

/**
 * Immediate subdirectories a stack recognises, for a root no stack does. A
 * repo with the app in `backend/` and nothing at the top got "could not tell
 * what kind of project this is" and no idea where to go instead.
 */
async function findSubprojects(projectDir: string, entries: readonly string[]): Promise<{ dir: string; stack: string }[]> {
  const found: { dir: string; stack: string }[] = [];
  for (const name of [...entries].sort()) {
    if (name.startsWith(".") || NOT_A_SUBPROJECT.has(name)) continue;
    let children: string[];
    try {
      children = await readdir(path.join(projectDir, name));
    } catch {
      continue; // a file, or unreadable
    }
    const matches = matchingStacks(children);
    if (matches.length > 0) found.push({ dir: name, stack: matches.map((m) => m.displayName).join("/") });
  }
  return found;
}

/**
 * Identifies which language stack a project is, and how to boot it.
 * `forcedStackId` (from --stack / twin.config.json) skips identification, which
 * is what a polyglot repo needs.
 */
export async function detectStack(projectDir: string, forcedStackId?: string): Promise<DetectedStack> {
  const entries = await readProjectEntries(projectDir);

  let profile: StackProfile;
  if (forcedStackId !== undefined) {
    const forced = stackProfile(forcedStackId);
    if (forced === undefined) {
      throw new TwinError("E_CONFIG_INVALID", `unknown stack "${forcedStackId}"`, {
        hint: `Known stacks: ${stackIds.join(", ")}.`
      });
    }
    profile = forced;
  } else {
    const matches = matchingStacks(entries);
    if (matches.length === 0) {
      const subprojects = await findSubprojects(projectDir, entries);
      throw new TwinError("E_NO_STACK", `could not tell what kind of project "${projectDir}" is`, {
        hint:
          subprojects.length > 0
            ? `${subprojects.map((s) => `"${s.dir}" looks like a ${s.stack} project`).join(", ")} - run Twin from ${
                subprojects.length === 1 ? "there" : "the one that serves HTTP"
              } (\`cd ${subprojects[0]!.dir}\`), or pass --stack <id> and --start "<command>" to run it from here.`
            : `No marker file for any known stack (${stackIds.join(", ")}) was found. Pass --stack <id> and --start "<command>".`,
        ...(subprojects.length > 0 ? { details: { subprojects: subprojects.map((s) => s.dir) } } : {})
      });
    }
    if (matches.length > 1) {
      throw new TwinError(
        "E_AMBIGUOUS_STACK",
        `"${projectDir}" looks like more than one stack at once: ${matches.map((m) => m.displayName).join(", ")}`,
        {
          hint: `Pass --stack <${matches.map((m) => m.id).join("|")}> to say which one serves HTTP, or set "stack" in twin.config.json.`,
          details: { candidates: matches.map((m) => m.id) }
        }
      );
    }
    profile = matches[0]!;
  }

  const files = await readMarkerFiles(projectDir, profile.reads);
  return { profile, startCommand: profile.resolveStartCommand({ files, entries, isWindows: process.platform === "win32" }) };
}

/** Resolves a start command, failing with E_NO_STACK when the stack is known but its entrypoint isn't. */
export async function detectStartCommand(projectDir: string, forcedStackId?: string): Promise<string> {
  const { profile, startCommand } = await detectStack(projectDir, forcedStackId);
  if (startCommand === undefined) {
    throw new TwinError("E_NO_STACK", `recognised "${projectDir}" as a ${profile.displayName} project, but couldn't tell how to start it`, {
      hint: 'Pass --start "<command>" explicitly, or set "start" in twin.config.json (see `twin init`). `{{port}}` in that command is replaced with the port Twin assigns.'
    });
  }
  return startCommand;
}

/** The stack id for a project, used to pick link/ignore dirs and tracer rules. */
export async function resolveStackProfile(projectDir: string, forcedStackId?: string): Promise<StackProfile> {
  return (await detectStack(projectDir, forcedStackId)).profile;
}

export type { StackId };
