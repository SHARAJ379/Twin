import type { Finding } from "../domain/check.js";
import type { DeploymentProfile } from "../domain/deploymentProfile.js";
import type { Verdict } from "../domain/verdict.js";
import { buildFixPrompt } from "./fixPrompt.js";

const ICON: Record<Finding["status"], string> = { pass: "✓", fail: "✗", error: "⚠", skipped: "·" };

function renderFinding(finding: Finding, profile: DeploymentProfile): string[] {
  const lines: string[] = [];
  lines.push(`${ICON[finding.status]} ${finding.status.toUpperCase().padEnd(7)} ${finding.checkId}`);
  lines.push(`  ${finding.summary}`);

  if (finding.status === "error" || finding.status === "skipped") {
    lines.push(`  reason: ${finding.reason}`);
  }
  for (const suspect of finding.suspects) {
    lines.push(`  likely cause: ${suspect.file}:${suspect.line}  ${suspect.snippet}  (${suspect.confidence} confidence)`);
  }
  if (finding.status === "fail") {
    lines.push("");
    lines.push("  Fix prompt (paste into Claude Code):");
    lines.push(`    "${buildFixPrompt(finding, profile)}"`);
  }
  return lines;
}

function renderVerdictLine(verdict: Verdict): string {
  const total = verdict.passed + verdict.failed + verdict.errored + verdict.skipped;
  if (verdict.safeForMultiInstance) {
    return `${verdict.passed} of ${total} checks passed - this app looks safe to run on more than one instance.`;
  }
  const problems = verdict.failed + verdict.errored;
  return `${problems} of ${total} checks failed or errored - this app is NOT safe to run on more than one instance.`;
}

/** The short terminal summary (§7.8): one block per check, then the verdict line. */
export function renderTerminalReport(findings: Finding[], verdict: Verdict, profile: DeploymentProfile): string {
  const lines: string[] = [`profile: ${profile}`, ""];
  for (const finding of findings) {
    lines.push(...renderFinding(finding, profile), "");
  }
  lines.push(renderVerdictLine(verdict));
  return lines.join("\n");
}
