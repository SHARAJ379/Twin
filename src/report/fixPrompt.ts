import type { DeploymentProfile } from "../domain/deploymentProfile.js";
import type { Finding } from "../domain/check.js";

/** §7.8: templated per SuspectKind once the tracer exists (milestone 5); a generic prompt when there are no suspects yet. */
export function buildFixPrompt(finding: Finding, profile: DeploymentProfile): string {
  const suspect = finding.suspects[0];

  if (suspect !== undefined) {
    return (
      `My app has a likely bug at ${suspect.file}:${suspect.line} (${suspect.snippet}) causing the ` +
      `"${finding.title}" check to fail under Twin's "${profile}" deployment profile: ${finding.summary} ` +
      `Fix the underlying issue while keeping behavior identical, then re-run \`twin run\`.`
    );
  }

  return (
    `My app fails the "${finding.title}" check under Twin's "${profile}" deployment profile: ${finding.summary} ` +
    `I don't have a specific file/line for this yet - look for in-memory state, local disk writes, or ` +
    `unsigned/in-process sessions that wouldn't survive running more than one instance. Fix the underlying ` +
    `issue while keeping behavior identical, then re-run \`twin run\`.`
  );
}
