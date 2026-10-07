import type { StackProfile } from "../stack.js";
import { goStack } from "./go.js";
import { nodeStack } from "./node.js";
import { phpStack } from "./php.js";
import { pythonStack } from "./python.js";
import { rubyStack } from "./ruby.js";

const known = [nodeStack, pythonStack, goStack, rubyStack, phpStack];

function union<T>(lists: readonly (readonly T[])[]): T[] {
  return [...new Set(lists.flat())];
}

/**
 * The fallback for a project Twin can't identify but was told how to boot
 * (`--start`). Never auto-detected - it has no markers. Linking and ignoring
 * every stack's directories is harmless (a link whose target doesn't exist is
 * skipped), and running every rule set means tracing still works: the patterns
 * are syntax-specific enough that another language's rules rarely match.
 */
export const genericStack: StackProfile = {
  id: "generic",
  displayName: "unknown stack",
  markers: [],
  reads: [],
  linkDirs: union(known.map((s) => s.linkDirs)),
  ignoreDirs: union(known.map((s) => s.ignoreDirs)),
  sourceExtensions: union(known.map((s) => s.sourceExtensions)),
  rules: union(known.map((s) => s.rules)),
  resolveStartCommand: () => undefined
};
