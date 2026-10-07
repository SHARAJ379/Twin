import type { Finding } from "../domain/check.js";
import type { DeploymentProfile } from "../domain/deploymentProfile.js";
import { totalChecks, verdictHeadline, type Verdict } from "../domain/verdict.js";
import { buildFixPrompt } from "./fixPrompt.js";

const HEADING: Record<Finding["status"], string> = { pass: "PASS", fail: "FAIL", error: "ERROR", skipped: "SKIPPED" };

function verdictSummary(verdict: Verdict): string {
  const total = totalChecks(verdict);
  switch (verdictHeadline(verdict)) {
    case "safe":
      return `**${verdict.passed} of ${total} checks passed** - this app looks safe to run on more than one instance.`;
    case "unsafe":
      return `**${verdict.failed + verdict.errored} of ${total} checks failed or errored** - this app is NOT safe to run on more than one instance.`;
    case "inconclusive":
      return total === 0
        ? "**No checks ran** - nothing in this scenario is tagged with `check:`, so Twin can't tell you anything about this app yet."
        : `**Twin could not tell** - ${verdict.passed} of ${total} checks passed, ${verdict.errored} errored, ${verdict.skipped} skipped.`;
  }
}

/** The human/Claude-friendly report (§7.8): includes a ready-to-paste fix prompt per failed check. */
export function renderMarkdownReport(
  scenarioName: string,
  findings: Finding[],
  verdict: Verdict,
  profile: DeploymentProfile
): string {
  const lines: string[] = [
    `# Twin report: ${scenarioName}`,
    "",
    `Profile: \`${profile}\``,
    "",
    verdictSummary(verdict),
    ""
  ];

  for (const finding of findings) {
    lines.push(`## ${HEADING[finding.status]} — ${finding.checkId}`, "", finding.summary, "");

    if (finding.status === "error" || finding.status === "skipped") {
      lines.push(`_Reason: ${finding.reason}_`, "");
    }
    for (const suspect of finding.suspects) {
      lines.push(`**Likely cause:** \`${suspect.file}:${suspect.line}\` - ${suspect.snippet} (${suspect.confidence} confidence)`, "");
    }
    if (finding.status === "fail") {
      lines.push("**Fix prompt (paste into Claude Code):**", "", "```", buildFixPrompt(finding, profile), "```", "");
    }
  }

  return lines.join("\n");
}
