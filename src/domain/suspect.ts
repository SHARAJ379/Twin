/** What kind of code a suspect is: the tracer (tracer/traceFindings.ts) picks the kinds relevant to each failing check. */
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
  /**
   * For a dynamic suspect, the workspace-diff path it was derived from. The
   * tracer uses it to tell which failing check this piece of evidence is
   * really about: a diff under the upload directory explains the check whose
   * own request asked for that file, not whichever other check happens to be
   * failing in the same run.
   */
  evidencePath?: string | undefined;
}
