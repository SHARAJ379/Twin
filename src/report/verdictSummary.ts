import type { Finding } from "../domain/check.js";
import { totalChecks, verdictHeadline, type Verdict } from "../domain/verdict.js";

/**
 * Whether a finding gets its own fix prompt. A blocked check (a 401/403
 * across instances, `blockedBy`) never reached its own subject, so its cause
 * is the session bug, not the check - unless nothing else in the run names
 * that bug, in which case the first blocked check is the one that does.
 */
export function getsFixPrompt(finding: Finding, findings: readonly Finding[]): boolean {
  if (finding.status !== "fail") return false;
  if (finding.blockedBy === undefined) return true;
  const unblocked = findings.some((f) => f.status === "fail" && f.blockedBy === undefined);
  return !unblocked && findings.find((f) => f.status === "fail" && f.blockedBy !== undefined) === finding;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The verdict as one sentence. For an unsafe run it counts bugs, not failed
 * checks: one in-memory session store fails every authenticated check after
 * it with a 401, and "4 of 4 checks failed" read as four bugs when the
 * README promises one bug with one cause.
 */
export function verdictSentence(verdict: Verdict, findings: readonly Finding[]): string {
  const total = totalChecks(verdict);
  switch (verdictHeadline(verdict)) {
    case "safe":
      return `${verdict.passed} of ${total} checks passed - this app looks safe to run on more than one instance.`;
    case "unsafe": {
      const bugs = findings.filter((f) => f.status === "fail" && f.blockedBy === undefined).map((f) => f.checkId);
      const blocked = findings.filter((f) => f.status === "fail" && f.blockedBy !== undefined);
      const found =
        bugs.length > 0
          ? `${plural(bugs.length, "bug")} found (${bugs.join(", ")})`
          : "1 bug found (authenticated requests were rejected on another instance)";
      const parts = [found];
      if (blocked.length > 0) {
        parts.push(
          `${plural(blocked.length, "check")} couldn't be tested because of ${bugs.length > 1 ? "them" : "it"} (${blocked
            .map((f) => f.checkId)
            .join(", ")})`
        );
      }
      if (verdict.errored > 0) parts.push(`${verdict.errored} errored`);
      return `${parts.join("; ")} - this app is NOT safe to run on more than one instance.`;
    }
    case "inconclusive":
      return total === 0
        ? "No checks ran - nothing in this scenario is tagged with `check:`, so Twin can't tell you anything about this app yet."
        : `Twin could not tell: ${verdict.passed} of ${total} checks passed, ${verdict.errored} errored, ${verdict.skipped} skipped. Fix the above and re-run.`;
  }
}
