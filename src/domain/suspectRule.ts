import type { SuspectKind } from "./suspect.js";

export interface SuspectRuleFixtures {
  /** Snippets that must produce at least one match - proof the rule actually fires. */
  matches: string[];
  /** Snippets that must produce zero matches - proof the rule isn't trigger-happy. */
  nonMatches: string[];
}

export interface SuspectRule {
  id: string;
  kind: SuspectKind;
  /** Static rules are capped below "high" (§6.5) - only a workspace-diff match earns that. */
  confidence: "medium" | "low";
  rationale: string;
  /** `line` is one source line; `fullFileContent` lets a rule look for cross-line context (e.g. "is there a store: anywhere in this file"). */
  test: (line: string, fullFileContent: string) => boolean;
  fixtures: SuspectRuleFixtures;
}
