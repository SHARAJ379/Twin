import type { Finding } from "../domain/check.js";
import type { DeploymentProfile } from "../domain/deploymentProfile.js";
import type { Verdict } from "../domain/verdict.js";

/** The machine contract for CI/GitHub Action/skill (§7.8) - schemaVersion follows semver, additive changes only in minors. */
export interface ReportJson {
  schemaVersion: 1;
  profile: DeploymentProfile;
  scenario: string;
  generatedAt: string;
  verdict: Verdict;
  findings: Finding[];
}

export function buildReportJson(params: {
  scenarioName: string;
  profile: DeploymentProfile;
  findings: Finding[];
  verdict: Verdict;
  generatedAt?: Date;
}): ReportJson {
  return {
    schemaVersion: 1,
    profile: params.profile,
    scenario: params.scenarioName,
    generatedAt: (params.generatedAt ?? new Date()).toISOString(),
    verdict: params.verdict,
    findings: params.findings
  };
}
