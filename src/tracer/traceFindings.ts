import type { Finding } from "../domain/check.js";
import type { CheckId } from "../domain/scenario.js";
import type { SuspectKind } from "../domain/suspect.js";
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
  "data-consistency": ["module-state", "sqlite-file"],
  "file-consistency": ["local-fs-write", "sqlite-file"],
  "restart-persistence": ["module-state", "sqlite-file", "local-fs-write"]
};

function relevantKindsFor(checkId: CheckId): SuspectKind[] {
  return RELEVANT_KINDS[checkId] ?? [];
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

    const relevantKinds = new Set(relevantKindsFor(finding.checkId));
    if (relevantKinds.size === 0) return finding;

    const dynamic = dynamicSuspects.filter((s) => relevantKinds.has(s.kind));
    const stat = staticSuspects.filter((s) => relevantKinds.has(s.kind));
    const suspects = [...dynamic, ...stat].slice(0, MAX_SUSPECTS_PER_FINDING);

    return suspects.length === 0 ? finding : { ...finding, suspects };
  });
}
