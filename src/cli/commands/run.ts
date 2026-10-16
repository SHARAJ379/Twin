import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runControlPhase } from "../../application/controlRun.js";
import { evaluate } from "../../application/evaluate.js";
import { runSplitPhase } from "../../application/splitRun.js";
import { builtInChecks } from "../../checks/index.js";
import type { DeploymentProfile } from "../../domain/deploymentProfile.js";
import { mergeEnvSources } from "../../domain/envSources.js";
import { TwinError } from "../../domain/errors.js";
import { collectSecretEnvValues, createLogRedactor } from "../../domain/logRedaction.js";
import { parseScenarioYaml, type ScenarioParseError } from "../../domain/scenarioParser.js";
import { scanForRemoteResources, scanForThirdPartyKeys } from "../../domain/safetyScan.js";
import type { StackProfile } from "../../domain/stack.js";
import { genericStack } from "../../domain/stacks/generic.js";
import { computeVerdict } from "../../domain/verdict.js";
import { FsArtifactStore } from "../../infra/artifacts/fsArtifactStore.js";
import { loadTwinConfig } from "../../infra/config/loadTwinConfig.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, HttpScenarioClient } from "../../infra/http/httpScenarioClient.js";
import { ProcessInstanceDriver } from "../../infra/process/processInstanceDriver.js";
import { HttpProxy } from "../../infra/proxy/httpProxy.js";
import { loadDotEnvFiles } from "../../infra/safety/loadDotEnvFiles.js";
import { detectStack } from "../../infra/stack/detectStack.js";
import { FsWorkspaceManager } from "../../infra/workspace/fsWorkspaceManager.js";
import type { Logger } from "../../ports/logger.js";
import { buildEvidenceLedger } from "../../report/evidenceLedger.js";
import { computeExitCode } from "../../report/exitCode.js";
import { renderMarkdownReport } from "../../report/markdown.js";
import { buildReportJson } from "../../report/reportJson.js";
import { renderTerminalReport } from "../../report/terminal.js";
import { traceFindings } from "../../tracer/traceFindings.js";
import { onShutdown } from "../shutdown.js";

export interface RunOptions {
  projectDir: string;
  /** Falls back to twin.config.json's "scenario" when omitted. */
  scenarioPath?: string | undefined;
  /** Forces the language stack instead of detecting it from marker files - needed for a polyglot repo. */
  stack?: string | undefined;
  /** Falls back to twin.config.json's "start", then the stack's own auto-detection, when omitted. */
  start?: string | undefined;
  /** Run once per instance workspace before `start`. Falls back to twin.config.json's "build". */
  build?: string | undefined;
  healthPath?: string | undefined;
  portEnv?: string | undefined;
  bootTimeoutMs?: number | undefined;
  /** Per-request deadline for a scenario step. Falls back to config, then DEFAULT_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number | undefined;
  /** Extra header names to redact from report evidence. Merged with twin.config.json's "redactHeaders". */
  redactHeaders?: string[] | undefined;
  env: Record<string, string>;
  keepWorkspaces: boolean;
  /** Bypasses the non-local-database refusal (§9.1, I8). Off by default - this is the single most important safety rule. */
  allowRemote: boolean;
  /** Vouches for specific hosts instead, leaving the check on for everything else. Merged with config's "allowRemoteHosts". */
  allowRemoteHosts?: string[] | undefined;
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
  /**
   * Set as soon as there is temp state worth removing. Called by the `finally`
   * below *and* by the signal handler: a run that threw (or was Ctrl-C'd) used
   * to leave a full copy of the project per instance behind in the temp dir,
   * and `twin clean` only ever reaped processes, never those.
   */
  let teardown: (() => Promise<void>) | undefined;
  let unregisterShutdown: (() => void) | undefined;

  try {
    const config = await loadTwinConfig(options.projectDir);

    const scenarioPath = options.scenarioPath ?? config?.scenario;
    if (scenarioPath === undefined) {
      throw new TwinError("E_SCENARIO_INVALID", "no scenario given", {
        hint: 'Pass --scenario <path>, or set "scenario" in twin.config.json (see `twin init`).'
      });
    }
    // A path typed on the command line is relative to where it was typed, like
    // in every other CLI. One from twin.config.json is relative to the project
    // that config belongs to, which is the only sense it could mean.
    const resolvedScenarioPath = path.isAbsolute(scenarioPath)
      ? scenarioPath
      : options.scenarioPath !== undefined
        ? path.resolve(scenarioPath)
        : path.join(options.projectDir, scenarioPath);

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

    const build = options.build ?? config?.build;
    const healthPath = options.healthPath ?? config?.healthPath ?? DEFAULT_HEALTH_PATH;
    const portEnv = options.portEnv ?? config?.portEnv ?? DEFAULT_PORT_ENV;
    const bootTimeoutMs = options.bootTimeoutMs ?? config?.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
    const requestTimeoutMs = options.requestTimeoutMs ?? config?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const redactExtraHeaders = [...(config?.redactHeaders ?? []), ...(options.redactHeaders ?? [])];
    const env = { ...config?.env, ...options.env };
    const allowRemote = options.allowRemote || config?.allowRemote === true;
    const allowedHosts = [...(config?.allowRemoteHosts ?? []), ...(options.allowRemoteHosts ?? [])];

    // Safety preflight (§9.1/§9.2, I8): scan every env source that would end
    // up inherited by a spawned instance - .env* files, Twin's own process
    // env (instances inherit it), twin.config.json's "env", and --env overrides.
    // Merged in precedence order, keeping which source won each key, so the
    // refusal can name the place to go and fix it.
    const dotEnvVars = await loadDotEnvFiles(options.projectDir);
    const { env: mergedEnv, originOf } = mergeEnvSources([
      { name: "a .env file in the project", vars: dotEnvVars },
      { name: "this shell's own environment", vars: process.env },
      { name: 'twin.config.json "env"', vars: config?.env ?? {} },
      { name: "--env", vars: options.env }
    ]);

    const remoteRefs = scanForRemoteResources(mergedEnv, { allowedHosts });
    if (remoteRefs.length > 0 && !allowRemote) {
      const list = remoteRefs.map((r) => `  ${r.key} -> ${r.host}   (set by ${originOf(r.key)})`).join("\n");
      const hosts = [...new Set(remoteRefs.map((r) => r.host))];
      throw new TwinError(
        "E_UNSAFE_ENV",
        `found what looks like a non-local database/service in the environment:\n${list}`,
        {
          hint: `Twin would write test users/records into this real database. Point it at a local one, vouch for ${
            hosts.length === 1 ? "this host" : "these hosts"
          } with ${hosts.map((host) => `--allow-remote-host ${host}`).join(" ")}, or turn the check off entirely with --allow-remote.`,
          details: { remoteRefs: remoteRefs.map((ref) => ({ ...ref, source: originOf(ref.key) })) }
        }
      );
    }

    const thirdPartyKeys = scanForThirdPartyKeys(mergedEnv);
    if (thirdPartyKeys.length > 0) {
      logger.warn("third-party service keys are present - the scenario may trigger real calls (Stripe/email/SMS/LLM)", {
        keys: thirdPartyKeys
      });
    }

    // Identified after the safety preflight on purpose: refusing to run
    // against a real database outranks every other complaint (I8).
    // The stack decides which dependency dirs are shared rather than copied,
    // what the tracer scans, and which static rules apply - so it's resolved
    // even when --start was given.
    const explicitStart = options.start ?? config?.start;
    let stack: StackProfile;
    let start: string | undefined;
    try {
      const detected = await detectStack(options.projectDir, options.stack ?? config?.stack);
      stack = detected.profile;
      start = explicitStart ?? detected.startCommand;
    } catch (err) {
      const unidentifiable =
        TwinError.isTwinError(err) && (err.code === "E_NO_STACK" || err.code === "E_AMBIGUOUS_STACK");
      // Being told exactly how to boot it makes identifying the stack a
      // nice-to-have, not a prerequisite. A bad --stack still fails hard.
      if (!unidentifiable || explicitStart === undefined) throw err;
      stack = genericStack;
      start = explicitStart;
      logger.warn(`couldn't identify the stack - continuing with --start and every stack's tracer rules`);
    }

    if (start === undefined) {
      throw new TwinError(
        "E_NO_STACK",
        `recognised "${options.projectDir}" as a ${stack.displayName} project, but couldn't tell how to start it`,
        {
          hint: 'Pass --start "<command>", or set "start" in twin.config.json. `{{port}}` in that command is replaced with the port Twin assigns.'
        }
      );
    }
    logger.info(`stack: ${stack.displayName}`, { start });

    const run = await store.createRun();
    const workspaceManager = new FsWorkspaceManager(path.join(os.tmpdir(), `twin-${run.id}`));
    // Instances inherit this environment, so these are exactly the secrets
    // their own output could echo - into the log files and into the boot-failure
    // tail Twin prints to the terminal (and therefore into CI logs).
    const redactLogLine = createLogRedactor(collectSecretEnvValues(mergedEnv));
    const instanceDriver = new ProcessInstanceDriver(
      workspaceManager,
      logger,
      store.pathFor(run, "pids.json"),
      store.pathFor(run, "logs"),
      redactLogLine
    );
    const scenarioClient = new HttpScenarioClient();
    const startSpec = { command: start, build, portEnv, env, healthPath, bootTimeoutMs };
    const clientOptions = { requestTimeoutMs, redactExtraHeaders };

    teardown = async () => {
      // Instances first: on Windows a workspace can't be removed while a
      // process still has its cwd inside it.
      await instanceDriver.stopAll({ graceMs: 2000 });
      if (!options.keepWorkspaces) await workspaceManager.cleanup();
    };
    unregisterShutdown = onShutdown(async () => {
      await teardown?.();
      await lock.release();
    });

    logger.info("CONTROL: running the scenario against one instance alone");
    const control = await runControlPhase(
      scenario,
      {
        sourceDir: options.projectDir,
        link: [...stack.linkDirs],
        ignore: [...stack.ignoreDirs],
        start: startSpec,
        client: clientOptions
      },
      instanceDriver,
      scenarioClient
    );

    logger.info("SPLIT: running the scenario against A + B behind the proxy");
    const proxy = new HttpProxy({ upstreamTimeoutMs: requestTimeoutMs });
    const split = await runSplitPhase(
      scenario,
      {
        sourceDir: options.projectDir,
        link: [...stack.linkDirs],
        ignore: [...stack.ignoreDirs],
        start: startSpec,
        instanceIds: ["A", "B"],
        client: clientOptions
      },
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
    const findings = await traceFindings(evaluated, options.projectDir, split.workspaceDiffs, stack, split.results);
    const verdict = computeVerdict(findings);

    const reportJson = buildReportJson({ scenarioName: scenario.name, profile: PROFILE, findings, verdict });
    await writeFile(store.pathFor(run, "report.json"), JSON.stringify(reportJson, null, 2), "utf8");
    // The evidence each finding points at. Already redacted on the way in
    // (domain/redaction.ts), which is what makes it safe to write down.
    const ledger = buildEvidenceLedger({
      scenarioName: scenario.name,
      controlResults: control.results,
      splitResults: split.results
    });
    await writeFile(store.pathFor(run, "results.json"), JSON.stringify(ledger, null, 2), "utf8");
    await writeFile(store.pathFor(run, "report.md"), renderMarkdownReport(scenario.name, findings, verdict, PROFILE), "utf8");
    await store.writeLatestPointer(run);
    await store.pruneOldRuns(10);

    console.log(renderTerminalReport(findings, verdict, PROFILE));
    logger.info("report saved", { dir: run.dir });

    return computeExitCode(verdict);
  } finally {
    unregisterShutdown?.();
    if (teardown !== undefined) {
      // A messy teardown must never replace the run's own result - or, worse,
      // mask the error that caused it.
      try {
        await teardown();
      } catch (err) {
        logger.warn("could not fully clean up this run", {
          error: err instanceof Error ? err.message : String(err),
          hint: "Run `twin clean` to reap any leftover processes."
        });
      }
    }
    await lock.release();
  }
}
