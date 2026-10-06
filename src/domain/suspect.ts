/** The tracer (§7.6, milestone 5) isn't built yet - this type exists now because Finding references it; every check currently reports []. */
export type SuspectKind =
  | "module-state"
  | "memory-session-store"
  | "local-fs-write"
  | "sqlite-file"
  | "in-memory-limiter"
  | (string & {});

export interface Suspect {
  file: string;
  line: number;
  snippet: string;
  kind: SuspectKind;
  confidence: "high" | "medium" | "low";
  rationale: string;
  source: "dynamic" | "static";
}
