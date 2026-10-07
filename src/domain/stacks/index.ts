import type { StackId, StackProfile } from "../stack.js";
import { goStack } from "./go.js";
import { nodeStack } from "./node.js";
import { phpStack } from "./php.js";
import { pythonStack } from "./python.js";
import { rubyStack } from "./ruby.js";

/** Every stack Twin knows how to boot and trace. Order is the tie-break when a repo matches more than one. */
export const stackProfiles: readonly StackProfile[] = [nodeStack, pythonStack, goStack, rubyStack, phpStack];

export function stackProfile(id: StackId): StackProfile | undefined {
  return stackProfiles.find((profile) => profile.id === id);
}

export const stackIds: readonly string[] = stackProfiles.map((profile) => profile.id);

/** Profiles whose markers are present at the project root. More than one means a polyglot repo. */
export function matchingStacks(entries: readonly string[]): StackProfile[] {
  const present = new Set(entries);
  return stackProfiles.filter((profile) => profile.markers.some((marker) => present.has(marker)));
}
