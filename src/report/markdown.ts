import type { Finding } from "../domain/check.js";
import type { DeploymentProfile } from "../domain/deploymentProfile.js";
import type { Verdict } from "../domain/verdict.js";
import { buildFixPrompt } from "./fixPrompt.js";

const HEADING: Record<Finding["status"], string> = { pass: "PASS", fail: "FAIL", error: "ERROR", skipped: "SKIPPED" };

/** The human/Claude-friendly report (§7.8): includes a ready-to-paste fix prompt per failed check. */
export function renderMarkdownReport(
  scenarioName: string,
  findings: Finding[],
  verdict: Verdict,
  profile: DeploymentProfile
): string {
  const total = verdict.passed + verdict.failed + verdict.errored + verdict.skipped;
  const lines: string[] = [
    `# Twin report: ${scenarioName}`,
    "",
    `Profile: \`${profile}\``,
    "",
    verdict.safeForMultiInstance
      ? `**${verdict.passed} of ${total} checks passed** - this app looks safe to run on more than one instance.`
      : `**${verdict.failed + verdict.errored} of ${total} checks failed or errored** - this app is NOT safe to run on more than one instance.`,
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
