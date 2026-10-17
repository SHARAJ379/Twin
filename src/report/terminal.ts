import type { Finding } from "../domain/check.js";
import type { DeploymentProfile } from "../domain/deploymentProfile.js";
import type { Verdict } from "../domain/verdict.js";
import { buildFixPrompt } from "./fixPrompt.js";
import { getsFixPrompt, verdictSentence } from "./verdictSummary.js";

const ICON: Record<Finding["status"], string> = { pass: "✓", fail: "✗", error: "⚠", skipped: "·" };

const BLOCKED_NOTE =
  "  blocked: rejected (401/403) on another instance, so this check never reached what it tests - the session bug above is the cause, not a separate one";

function renderFinding(finding: Finding, findings: readonly Finding[], profile: DeploymentProfile): string[] {
  const lines: string[] = [];
  const blocked = finding.status === "fail" && finding.blockedBy !== undefined;
  const label = blocked ? "BLOCKED" : finding.status.toUpperCase();
  lines.push(`${ICON[finding.status]} ${label.padEnd(7)} ${finding.checkId}`);
  lines.push(`  ${finding.summary}`);
  const prompt = getsFixPrompt(finding, findings);
  if (blocked && !prompt) {
    lines.push(BLOCKED_NOTE);
    return lines;
  }

  if (finding.status === "error" || finding.status === "skipped") {
    lines.push(`  reason: ${finding.reason}`);
  }
  for (const suspect of finding.suspects) {
    lines.push(`  likely cause: ${suspect.file}:${suspect.line}  ${suspect.snippet}  (${suspect.confidence} confidence)`);
  }
  if (prompt) {
    lines.push("");
    lines.push("  Fix prompt (paste into Claude Code):");
    // An indented block, not a quoted string: the prompt has double quotes of
    // its own, and wrapping quotes made it awkward to copy.
    lines.push(`    ${buildFixPrompt(finding, profile)}`);
  }
  return lines;
}

/** The short terminal summary (§7.8): one block per check, then the verdict line. */
export function renderTerminalReport(findings: Finding[], verdict: Verdict, profile: DeploymentProfile): string {
  const lines: string[] = [`profile: ${profile}`, ""];
  for (const finding of findings) {
    lines.push(...renderFinding(finding, findings, profile), "");
  }
  lines.push(verdictSentence(verdict, findings));
  return lines.join("\n");
}
