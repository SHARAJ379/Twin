import type { SuspectRule } from "./suspectRule.js";

/** A string, not a closed union, so a plugin stack is additive rather than breaking (§13). */
export type StackId = "node" | "python" | "go" | "ruby" | "php" | (string & {});

/** What infra read from the project root so a profile can decide things without doing I/O itself. */
export interface StackDetectionInput {
  /** Contents of the profile's `reads` files, keyed by name. Absent if the file isn't there. */
  files: Readonly<Record<string, string>>;
  /** Names of entries at the project root, files and directories alike. */
  entries: readonly string[];
  /** Interpreter paths inside a virtualenv differ by platform, and a start command has to name one. */
  isWindows: boolean;
}

/**
 * Everything Twin needs to know about one language stack. Deliberately pure
 * data plus pure functions (invariant I6) - detection does the file reading
 * and hands the results in, so every profile is testable without a project
 * on disk, and without that language's runtime installed.
 */
export interface StackProfile {
  id: StackId;
  displayName: string;
  /** Any one of these present at the project root identifies this stack. */
  markers: readonly string[];
  /** Files whose contents resolveStartCommand() needs; read only if present. */
  reads: readonly string[];
  /** Dependency directories symlinked from the source rather than deep-copied, so instances share one install. */
  linkDirs: readonly string[];
  /** Build/cache noise to skip when copying a workspace and when scanning for suspects. */
  ignoreDirs: readonly string[];
  /** Extensions the tracer scans for this stack's source. */
  sourceExtensions: readonly string[];
  rules: readonly SuspectRule[];
  /**
   * The command that boots the app, or undefined if this stack can't tell.
   * May contain `{{port}}`, which the driver replaces with the port it
   * allocated - most non-Node servers take a port as an argument rather than
   * reading one from the environment, and `$PORT`/`%PORT%` isn't portable.
   */
  resolveStartCommand(input: StackDetectionInput): string | undefined;
}
