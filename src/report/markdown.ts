import type { Finding } from "../domain/check.js";
import type { DeploymentProfile } from "../domain/deploymentProfile.js";
import type { Verdict } from "../domain/verdict.js";
import { buildFixPrompt } from "./fixPrompt.js";
import { getsFixPrompt, statusLabel, verdictSentence } from "./verdictSummary.js";


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
    `**${verdictSentence(verdict, findings)}**`,
    ""
  ];

  for (const finding of findings) {
    const blocked = finding.blockedBy !== undefined;
    const prompt = getsFixPrompt(finding, findings);
    lines.push(`## ${statusLabel(finding)} — ${finding.checkId}`, "", finding.summary, "");
    if (blocked && !prompt) {
      lines.push(
        finding.blockedBy === "auth"
          ? "_Blocked: rejected (401/403) on another instance, so this check never reached what it tests. The session bug above is the cause, not a separate one._"
          : `_Blocked: ${"reason" in finding ? finding.reason : ""}._`,
        ""
      );
      continue;
    }

    if (finding.status === "error" || finding.status === "skipped") {
      lines.push(`_Reason: ${finding.reason}_`, "");
    }
    for (const suspect of finding.suspects) {
      lines.push(`**Likely cause:** \`${suspect.file}:${suspect.line}\` - ${suspect.snippet} (${suspect.confidence} confidence)`, "");
    }
    if (prompt) {
      lines.push("**Fix prompt (paste into Claude Code):**", "", "```", buildFixPrompt(finding, profile), "```", "");
    }
  }

  return lines.join("\n");
}
