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
import { scanForRemoteResources, scanForThirdPartyKeys } from "../../domain/safetyScan.js";
import { computeVerdict } from "../../domain/verdict.js";
import { FsArtifactStore } from "../../infra/artifacts/fsArtifactStore.js";
import { loadTwinConfig } from "../../infra/config/loadTwinConfig.js";
import { HttpScenarioClient } from "../../infra/http/httpScenarioClient.js";
import { ProcessInstanceDriver } from "../../infra/process/processInstanceDriver.js";
import { HttpProxy } from "../../infra/proxy/httpProxy.js";
import { loadDotEnvFiles } from "../../infra/safety/loadDotEnvFiles.js";
import { detectStartCommand } from "../../infra/stack/detectStartCommand.js";
import { FsWorkspaceManager } from "../../infra/workspace/fsWorkspaceManager.js";
import type { Logger } from "../../ports/logger.js";
import { computeExitCode } from "../../report/exitCode.js";
import { renderMarkdownReport } from "../../report/markdown.js";
import { buildReportJson } from "../../report/reportJson.js";
import { renderTerminalReport } from "../../report/terminal.js";
import { traceFindings } from "../../tracer/traceFindings.js";

export interface RunOptions {
  projectDir: string;
  /** Falls back to twin.config.json's "scenario" when omitted. */
  scenarioPath?: string | undefined;
  /** Falls back to twin.config.json's "start", then package.json-based auto-detection, when omitted. */
  start?: string | undefined;
  /** Run once per instance workspace before `start`. Falls back to twin.config.json's "build". */
  build?: string | undefined;
  healthPath?: string | undefined;
  portEnv?: string | undefined;
  bootTimeoutMs?: number | undefined;
  env: Record<string, string>;
  keepWorkspaces: boolean;
  /** Bypasses the non-local-database refusal (§9.1, I8). Off by default - this is the single most important safety rule. */
  allowRemote: boolean;
}

const PROFILE: DeploymentProfile = "ephemeral";
const DEFAULT_HEALTH_PATH = "/health";
const DEFAULT_PORT_ENV = "PORT";
const DEFAULT_BOOT_TIMEOUT_MS = 60_000;

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
    const config = await loadTwinConfig(options.projectDir);

    const scenarioPath = options.scenarioPath ?? config?.scenario;
    if (scenarioPath === undefined) {
      throw new TwinError("E_SCENARIO_INVALID", "no scenario given", {
        hint: 'Pass --scenario <path>, or set "scenario" in twin.config.json (see `twin init`).'
      });
    }
    const resolvedScenarioPath = path.isAbsolute(scenarioPath) ? scenarioPath : path.join(options.projectDir, scenarioPath);

    let scenarioText: string;
    try {
      scenarioText = await readFile(resolvedScenarioPath, "utf8");
    } catch (err) {
      throw new TwinError("E_SCENARIO_INVALID", `could not read scenario file "${resolvedScenarioPath}"`, {
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

    const start = options.start ?? config?.start ?? (await detectStartCommand(options.projectDir));
    const build = options.build ?? config?.build;
    const healthPath = options.healthPath ?? config?.healthPath ?? DEFAULT_HEALTH_PATH;
    const portEnv = options.portEnv ?? config?.portEnv ?? DEFAULT_PORT_ENV;
    const bootTimeoutMs = options.bootTimeoutMs ?? config?.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
    const env = { ...config?.env, ...options.env };
    const allowRemote = options.allowRemote || config?.allowRemote === true;

    // Safety preflight (§9.1/§9.2, I8): scan every env source that would end
    // up inherited by a spawned instance - .env* files, Twin's own process
    // env (instances inherit it), twin.config.json's "env", and --env overrides.
    const dotEnvVars = await loadDotEnvFiles(options.projectDir);
    const mergedEnv = { ...dotEnvVars, ...process.env, ...env } as Record<string, string>;

    const remoteRefs = scanForRemoteResources(mergedEnv);
    if (remoteRefs.length > 0 && !allowRemote) {
      const list = remoteRefs.map((r) => `  ${r.key} -> ${r.host}`).join("\n");
      throw new TwinError(
        "E_UNSAFE_ENV",
        `found what looks like a non-local database/service in the environment:\n${list}`,
        {
          hint: "Twin would write test users/records into this real database. If that's genuinely fine, pass --allow-remote.",
          details: { remoteRefs }
        }
      );
    }

    const thirdPartyKeys = scanForThirdPartyKeys(mergedEnv);
    if (thirdPartyKeys.length > 0) {
      logger.warn("third-party service keys are present - the scenario may trigger real calls (Stripe/email/SMS/LLM)", {
        keys: thirdPartyKeys
      });
    }

    const run = await store.createRun();
    const workspaceManager = new FsWorkspaceManager(path.join(os.tmpdir(), `twin-${run.id}`));
    const instanceDriver = new ProcessInstanceDriver(workspaceManager, logger, store.pathFor(run, "pids.json"));
    const scenarioClient = new HttpScenarioClient();
    const startSpec = { command: start, build, portEnv, env, healthPath, bootTimeoutMs };

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

    const evaluated = evaluate({
      scenario,
      controlResults: control.results,
      splitResults: split.results,
      workspaceDiffs: split.workspaceDiffs,
      checks: builtInChecks,
      profile: PROFILE
    });

    logger.info("TRACE: mapping any failing checks to likely code locations");
    const findings = await traceFindings(evaluated, options.projectDir, split.workspaceDiffs);
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
