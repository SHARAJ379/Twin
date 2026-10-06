import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runControlPhase } from "../../application/controlRun.js";
import { evaluate } from "../../application/evaluate.js";
import { runSplitPhase } from "../../application/splitRun.js";
import { builtInChecks } from "../../checks/index.js";
import type { DeploymentProfile } from "../../domain/deploymentProfile.js";
import { TwinError } from "../../domain/errors.js";
import { parseScenarioYaml, type ScenarioParseError } from "../../domain/scenarioParser.js";
import { computeVerdict } from "../../domain/verdict.js";
import { FsArtifactStore } from "../../infra/artifacts/fsArtifactStore.js";
import { HttpScenarioClient } from "../../infra/http/httpScenarioClient.js";
import { ProcessInstanceDriver } from "../../infra/process/processInstanceDriver.js";
import { HttpProxy } from "../../infra/proxy/httpProxy.js";
import { FsWorkspaceManager } from "../../infra/workspace/fsWorkspaceManager.js";
import type { Logger } from "../../ports/logger.js";
import { computeExitCode } from "../../report/exitCode.js";
import { renderMarkdownReport } from "../../report/markdown.js";
import { buildReportJson } from "../../report/reportJson.js";
import { renderTerminalReport } from "../../report/terminal.js";

export interface RunOptions {
  projectDir: string;
  scenarioPath: string;
  start: string;
  healthPath: string;
  portEnv: string;
  bootTimeoutMs: number;
  env: Record<string, string>;
  keepWorkspaces: boolean;
}

const PROFILE: DeploymentProfile = "ephemeral";

function formatScenarioErrors(errors: ScenarioParseError[]): string {
  return errors
    .map((e) => {
      const loc = e.line !== undefined ? ` (line ${e.line}:${e.column ?? 0})` : "";
      return `  ${e.path.length > 0 ? e.path : "(root)"}${loc}: ${e.message}`;
    })
    .join("\n");
}

/** `twin run`: PREFLIGHT -> CONTROL -> SPLIT -> EVALUATE -> REPORT, per TWIN_ARCHITECTURE.md §3. Returns the process exit code. */
export async function runCommand(options: RunOptions, logger: Logger): Promise<number> {
  const store = new FsArtifactStore(options.projectDir);
  const lock = await store.acquireLock();

  try {
    let scenarioText: string;
    try {
      scenarioText = await readFile(options.scenarioPath, "utf8");
    } catch (err) {
      throw new TwinError("E_SCENARIO_INVALID", `could not read scenario file "${options.scenarioPath}"`, {
        hint: "Check the --scenario path.",
        cause: err
      });
    }

    const parsed = parseScenarioYaml(scenarioText);
    if (!parsed.ok) {
      throw new TwinError("E_SCENARIO_INVALID", `scenario is invalid:\n${formatScenarioErrors(parsed.errors)}`, {
        hint: "Fix the scenario and re-run `twin run`.",
        details: { errors: parsed.errors }
      });
    }
    const scenario = parsed.scenario;

    const run = await store.createRun();
    const workspaceManager = new FsWorkspaceManager(path.join(os.tmpdir(), `twin-${run.id}`));
    const instanceDriver = new ProcessInstanceDriver(workspaceManager, logger, store.pathFor(run, "pids.json"));
    const scenarioClient = new HttpScenarioClient();
    const startSpec = {
      command: options.start,
      portEnv: options.portEnv,
      env: options.env,
      healthPath: options.healthPath,
      bootTimeoutMs: options.bootTimeoutMs
    };

    logger.info("CONTROL: running the scenario against one instance alone");
    const control = await runControlPhase(
      scenario,
      { sourceDir: options.projectDir, link: ["node_modules"], ignore: [], start: startSpec },
      instanceDriver,
      scenarioClient
    );

    logger.info("SPLIT: running the scenario against A + B behind the proxy");
    const proxy = new HttpProxy();
    const split = await runSplitPhase(
      scenario,
      { sourceDir: options.projectDir, link: ["node_modules"], ignore: [], start: startSpec, instanceIds: ["A", "B"] },
      instanceDriver,
      proxy,
      scenarioClient
    );

    const findings = evaluate({
      scenario,
      controlResults: control.results,
      splitResults: split.results,
      checks: builtInChecks,
      profile: PROFILE
    });
    const verdict = computeVerdict(findings);

    const reportJson = buildReportJson({ scenarioName: scenario.name, profile: PROFILE, findings, verdict });
    await writeFile(store.pathFor(run, "report.json"), JSON.stringify(reportJson, null, 2), "utf8");
    await writeFile(store.pathFor(run, "report.md"), renderMarkdownReport(scenario.name, findings, verdict, PROFILE), "utf8");
    await store.writeLatestPointer(run);
    await store.pruneOldRuns(10);

    console.log(renderTerminalReport(findings, verdict, PROFILE));
    logger.info("report saved", { dir: run.dir });

    if (!options.keepWorkspaces) await workspaceManager.cleanup();

    return computeExitCode(verdict);
  } finally {
    await lock.release();
  }
}
