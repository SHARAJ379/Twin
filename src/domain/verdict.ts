import type { Finding } from "./check.js";

export interface Verdict {
  passed: number;
  failed: number;
  /**
   * How many of `failed` are blocked: rejected with a 401/403 across
   * instances, so they never reached their own subject (`blockedBy`). One
   * session bug fails every authenticated check after it; those are one bug
   * with one cause, counted here so the report can say so. Absent in reports
   * written before it existed.
   */
  blocked?: number;
  errored: number;
  skipped: number;
  safeForMultiInstance: boolean;
}

/**
 * What the run actually established:
 * - "unsafe": a check proved a real multi-instance bug.
 * - "inconclusive": Twin couldn't tell - something errored, or nothing was
 *   verified at all (no checks, or every check skipped). Never report this as
 *   a clean bill of health: no evidence is not the same as no bug.
 * - "safe": at least one check passed and nothing failed or errored.
 */
export type VerdictHeadline = "safe" | "unsafe" | "inconclusive";

export function verdictHeadline(verdict: Verdict): VerdictHeadline {
  if (verdict.failed > 0) return "unsafe";
  if (verdict.errored > 0) return "inconclusive";
  if (verdict.passed === 0) return "inconclusive";
  return "safe";
}

export function totalChecks(verdict: Verdict): number {
  return verdict.passed + verdict.failed + verdict.errored + verdict.skipped;
}

export function computeVerdict(findings: Finding[]): Verdict {
  const verdict: Verdict = { passed: 0, failed: 0, blocked: 0, errored: 0, skipped: 0, safeForMultiInstance: false };

  for (const finding of findings) {
    if (finding.status === "pass") verdict.passed++;
    else if (finding.status === "fail") {
      verdict.failed++;
      if (finding.blockedBy !== undefined) verdict.blocked = (verdict.blocked ?? 0) + 1;
    }
    else if (finding.status === "error") verdict.errored++;
    else verdict.skipped++;
  }

  verdict.safeForMultiInstance = verdictHeadline(verdict) === "safe";
  return verdict;
}
