import type { Finding } from "../domain/check.js";
import type { CheckId } from "../domain/scenario.js";
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
  "session-survives-switch": ["memory-session-store", "module-state"],
  // local-fs-write belongs here too: a JSON/flat file store is as common a
  // reason records don't cross instances as an in-memory object is.
  "data-consistency": ["module-state", "sqlite-file", "local-fs-write"],
  "file-consistency": ["local-fs-write", "sqlite-file"],
  "restart-persistence": ["module-state", "sqlite-file", "local-fs-write"]
};

function relevantKindsFor(checkId: CheckId): SuspectKind[] {
  return RELEVANT_KINDS[checkId] ?? [];
}

const CONFIDENCE_RANK: Record<Suspect["confidence"], number> = { high: 0, medium: 1, low: 2 };

/**
 * Orders suspects before the cap applies, so the most relevant one can never
 * be crowded out by one that merely comes from an earlier-declared rule:
 * dynamic (workspace-diff) evidence first (§7.6), then the kind order
 * declared in RELEVANT_KINDS, then confidence, then file/line order.
 */
function rankSuspects(suspects: Suspect[], kindPriority: SuspectKind[]): Suspect[] {
  const kindRank = new Map(kindPriority.map((kind, index) => [kind, index] as const));
  const rankOf = (kind: SuspectKind): number => kindRank.get(kind) ?? Number.MAX_SAFE_INTEGER;

  return suspects
    .map((suspect, index) => ({ suspect, index }))
    .sort((a, b) => {
      const bySource = (a.suspect.source === "dynamic" ? 0 : 1) - (b.suspect.source === "dynamic" ? 0 : 1);
      if (bySource !== 0) return bySource;
      const byKind = rankOf(a.suspect.kind) - rankOf(b.suspect.kind);
      if (byKind !== 0) return byKind;
      const byConfidence = CONFIDENCE_RANK[a.suspect.confidence] - CONFIDENCE_RANK[b.suspect.confidence];
      if (byConfidence !== 0) return byConfidence;
      return a.index - b.index;
    })
    .map((entry) => entry.suspect);
}

/**
 * TRACE phase (§3): maps failing findings to code suspects, dynamic
 * evidence first (§7.6). Non-fatal by design - a finding simply keeps an
 * empty suspects list if nothing is found, never an error.
 */
export async function traceFindings(findings: Finding[], projectDir: string, workspaceDiffs: WorkspaceDiff[]): Promise<Finding[]> {
  if (!findings.some((f) => f.status === "fail")) return findings; // nothing to trace

  const sourceFiles = await listSourceFiles(projectDir);
  const staticSuspects = await findStaticSuspects(sourceFiles, projectDir);
  const dynamicSuspects = (
    await Promise.all(workspaceDiffs.map((diff) => findDynamicSuspects(projectDir, diff, sourceFiles)))
  ).flat();

  return findings.map((finding) => {
    if (finding.status !== "fail") return finding;

    const relevantKinds = relevantKindsFor(finding.checkId);
    if (relevantKinds.length === 0) return finding;
    const isRelevant = new Set(relevantKinds);

    const relevant = [...dynamicSuspects, ...staticSuspects].filter((s) => isRelevant.has(s.kind));
    const suspects = rankSuspects(relevant, relevantKinds).slice(0, MAX_SUSPECTS_PER_FINDING);

    return suspects.length === 0 ? finding : { ...finding, suspects };
  });
}
