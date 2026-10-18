import type { Finding } from "../domain/check.js";
import type { StackProfile } from "../domain/stack.js";
import type { StepResult } from "../domain/stepResult.js";
import type { Suspect, SuspectKind } from "../domain/suspect.js";
import type { WorkspaceDiff } from "../domain/workspaceDiff.js";
import { findDynamicSuspects } from "./findDynamicSuspects.js";
import { findStaticSuspects } from "./findStaticSuspects.js";
import { listSourceFiles } from "./sourceFiles.js";

const MAX_SUSPECTS_PER_FINDING = 3;

/** Which suspect kinds are relevant evidence for each built-in check (§6.5b: session has no file footprint, so no sqlite/fs kinds). */
const RELEVANT_KINDS: Record<string, SuspectKind[]> = {
  // A broken session store is just as often a plain module-level object
  // (as in examples/broken-express) as it is express-session misconfigured
  // without a `store:` - both are "memory-session-store"'s and "module-state"'s territory.
  "session-survives-switch": ["memory-session-store", "module-state", "local-fs-write"],
  // local-fs-write belongs here too: a JSON/flat file store is as common a
  // reason records don't cross instances as an in-memory object is.
  "data-consistency": ["module-state", "sqlite-file", "local-fs-write"],
  "file-consistency": ["local-fs-write", "sqlite-file"],
  "restart-persistence": ["module-state", "sqlite-file", "local-fs-write"]
};

/**
 * The kinds a *session* failure points at. A check blocked by a 401/403 is
 * judged by these rather than by its own id: the request was refused before it
 * reached the store the check is named after, so the store's code can't be
 * what explains it (domain/authRejection.ts).
 */
const AUTH_BLOCKED_KINDS: SuspectKind[] = ["memory-session-store", "module-state", "local-fs-write"];

/** A container whose name says it holds sessions or logins: `sessions = {}`, `const tokens = new Map()`. */
const SESSION_NAME = /sess|sid|token|auth|login|jwt|cookie/i;

/** The variable a suspect's line declares or assigns, if it has one. */
function declaredName(snippet: string): string | undefined {
  return /^(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=/.exec(snippet)?.[1];
}

/**
 * Whether a suspect can explain a *session* failure. A session-store rule
 * can; a plain module-level container only when its name says it holds
 * sessions, and a local file write only when it writes sessions
 * (`file_put_contents($sessionDir . ...)`). `const items = []` was listed as
 * a session failure's likely cause - pointing someone at their data store to
 * fix their login.
 */
function isSessionSpecific(suspect: Suspect): boolean {
  if (suspect.kind === "memory-session-store") return true;
  if (suspect.kind === "local-fs-write") return SESSION_NAME.test(suspect.snippet);
  if (suspect.kind !== "module-state") return false;
  const name = declaredName(suspect.snippet);
  return name !== undefined && SESSION_NAME.test(name);
}

function isSessionFailure(finding: Finding): boolean {
  return finding.checkId === "session-survives-switch" || finding.blockedBy === "auth";
}

function relevantKindsFor(finding: Finding): SuspectKind[] {
  if (finding.blockedBy === "auth") return AUTH_BLOCKED_KINDS;
  return RELEVANT_KINDS[finding.checkId] ?? [];
}

const CONFIDENCE_RANK: Record<Suspect["confidence"], number> = { high: 0, medium: 1, low: 2 };

/**
 * Does this finding's own failing request name the file the suspect came from?
 * Matching on the basename is what works in practice: an upload's path is
 * generated (`/uploads/twin-test-4f2a.txt` against a diff entry of
 * `uploads/twin-test-4f2a.txt`), while a record read goes through an id that
 * shares nothing with the store file's name (`/items/3` against `data.json`).
 */
function referencesEvidence(requestPath: string | undefined, suspect: Suspect): boolean {
  if (requestPath === undefined || suspect.evidencePath === undefined) return false;
  const basename = suspect.evidencePath.split("/").pop();
  return basename !== undefined && basename.length > 0 && requestPath.includes(basename);
}

/** The path of the split-run request that failed for this finding, if the ledger has one. */
function failingRequestPath(finding: Finding, splitResults: ReadonlyMap<string, StepResult>): string | undefined {
  for (const ref of finding.evidence) {
    if (ref.run !== "split") continue;
    const path = splitResults.get(ref.stepId)?.request?.path;
    if (path !== undefined) return path;
  }
  return undefined;
}

/**
 * Orders suspects before the cap applies, so the most relevant one can never
 * be crowded out by one that merely comes from an earlier-declared rule: the
 * kind order declared for this finding first, then dynamic (workspace-diff)
 * evidence ahead of static (§7.6), then confidence, then file/line order.
 *
 * Kind outranks source deliberately. Dynamic evidence is proof rather than a
 * guess, which is why it wins among suspects of equal relevance - but it is
 * proof about the file it came from, and a workspace diff under the upload
 * directory is proof about files whatever the failing check happens to be.
 * Ranking source first let it lead `data-consistency`'s list with the upload
 * path, pushing the in-memory record store the check is actually about off
 * the end of the cap.
 *
 * Every tier is a property of the suspect, so the order is the same on every
 * run - nothing here depends on which rule matched first or on how the
 * workspace diff happened to be walked.
 *
 * Within one kind, evidence the failing request actually asked for comes
 * first: an app that keeps both its records and its uploads on local disk
 * produces the same handful of `local-fs-write` suspects for every file-backed
 * check, and the request path is what tells `file-consistency`'s upload apart
 * from `data-consistency`'s record store.
 */
function rankSuspects(suspects: Suspect[], kindPriority: SuspectKind[], requestPath: string | undefined): Suspect[] {
  const kindRank = new Map(kindPriority.map((kind, index) => [kind, index] as const));
  const rankOf = (kind: SuspectKind): number => kindRank.get(kind) ?? Number.MAX_SAFE_INTEGER;
  const asksForEvidence = (suspect: Suspect): number => (referencesEvidence(requestPath, suspect) ? 0 : 1);

  return suspects
    .map((suspect, index) => ({ suspect, index }))
    .sort((a, b) => {
      const byKind = rankOf(a.suspect.kind) - rankOf(b.suspect.kind);
      if (byKind !== 0) return byKind;
      const byRequest = asksForEvidence(a.suspect) - asksForEvidence(b.suspect);
      if (byRequest !== 0) return byRequest;
      const bySource = (a.suspect.source === "dynamic" ? 0 : 1) - (b.suspect.source === "dynamic" ? 0 : 1);
      if (bySource !== 0) return bySource;
      const byConfidence = CONFIDENCE_RANK[a.suspect.confidence] - CONFIDENCE_RANK[b.suspect.confidence];
      if (byConfidence !== 0) return byConfidence;
      // File/line, not discovery order: a dynamic suspect's position depended
      // on whether its file landed in the diff's `added` or `modified` list,
      // so which of two equally ranked suspects led the report came down to
      // whether this run was the one that created the store file.
      const byFile = a.suspect.file.localeCompare(b.suspect.file);
      if (byFile !== 0) return byFile;
      const byLine = a.suspect.line - b.suspect.line;
      if (byLine !== 0) return byLine;
      return a.index - b.index;
    })
    .map((entry) => entry.suspect);
}

/**
 * TRACE phase (§3): maps failing findings to code suspects, dynamic
 * evidence first (§7.6). Non-fatal by design - a finding simply keeps an
 * empty suspects list if nothing is found, never an error.
 */
export async function traceFindings(
  findings: Finding[],
  projectDir: string,
  workspaceDiffs: WorkspaceDiff[],
  stack: StackProfile,
  /** The SPLIT run's step results, so a finding's suspects can be ranked against the request that actually failed. */
  splitResults: StepResult[] = []
): Promise<Finding[]> {
  if (!findings.some((f) => f.status === "fail")) return findings; // nothing to trace

  const splitById = new Map(splitResults.map((result) => [result.stepId, result] as const));
  const sourceFiles = await listSourceFiles(projectDir, stack.sourceExtensions, stack.ignoreDirs);
  const staticSuspects = await findStaticSuspects(sourceFiles, projectDir, stack.rules);
  const dynamicSuspects = (
    await Promise.all(workspaceDiffs.map((diff) => findDynamicSuspects(projectDir, diff, sourceFiles)))
  ).flat();

  return findings.map((finding) => {
    if (finding.status !== "fail") return finding;

    const relevantKinds = relevantKindsFor(finding);
    if (relevantKinds.length === 0) return finding;
    const isRelevant = new Set(relevantKinds);

    // A session failure only names session-specific code, or nothing at all:
    // no confident suspect beats a confident-looking wrong one.
    const relevant = [...dynamicSuspects, ...staticSuspects].filter(
      (s) => isRelevant.has(s.kind) && (!isSessionFailure(finding) || isSessionSpecific(s))
    );
    const requestPath = failingRequestPath(finding, splitById);
    // One line, once: the same line can be both runtime evidence and a static
    // rule's match, and listing it twice crowded a different suspect out of the cap.
    const seen = new Set<string>();
    const suspects = rankSuspects(relevant, relevantKinds, requestPath)
      .filter((s) => {
        const key = `${s.file}:${s.line}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_SUSPECTS_PER_FINDING);

    return suspects.length === 0 ? finding : { ...finding, suspects };
  });
}
