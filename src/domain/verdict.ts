import type { Finding } from "./check.js";

export interface Verdict {
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  safeForMultiInstance: boolean;
}

export function computeVerdict(findings: Finding[]): Verdict {
  const verdict: Verdict = { passed: 0, failed: 0, errored: 0, skipped: 0, safeForMultiInstance: true };

  for (const finding of findings) {
    if (finding.status === "pass") verdict.passed++;
    else if (finding.status === "fail") verdict.failed++;
    else if (finding.status === "error") verdict.errored++;
    else verdict.skipped++;
  }

  // "Safe" requires every check to have actually passed - an unresolved
  // error is not a clean bill of health, it's Twin saying it couldn't tell.
  verdict.safeForMultiInstance = verdict.failed === 0 && verdict.errored === 0;
  return verdict;
}
