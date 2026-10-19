import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runControlPhase } from "../../application/controlRun.js";
import { evaluate } from "../../application/evaluate.js";
import { runSplitPhase } from "../../application/splitRun.js";
import { builtInChecks } from "../../checks/index.js";
import type { DeploymentProfile } from "../../domain/deploymentProfile.js";
import { collectEnvCandidates, mergeEnvSources } from "../../domain/envSources.js";
import { TwinError } from "../../domain/errors.js";
import { collectSecretEnvValues, createLogRedactor } from "../../domain/logRedaction.js";
import { loopbackHostEnv } from "../../domain/loopbackHost.js";
import { parseScenarioYaml, type ScenarioParseError } from "../../domain/scenarioParser.js";
import { changedPaths, isWithin, localPathsInEnv, markUnprovenByLocalDisk } from "../../domain/sharedDisk.js";
import {
  findDatastoreSettings,
  scanEnvCandidatesForRemoteResources,
  scanForThirdPartyKeys,
  scanSourceForRemoteResources
} from "../../domain/safetyScan.js";
import { quoteForShell } from "../../domain/shellQuote.js";
import type { StackProfile } from "../../domain/stack.js";
import { genericStack } from "../../domain/stacks/generic.js";
import { stackProfiles } from "../../domain/stacks/index.js";
import { computeVerdict } from "../../domain/verdict.js";
import { FsArtifactStore } from "../../infra/artifacts/fsArtifactStore.js";
import { prepareCompileOutput } from "../../infra/build/prepareCompileOutput.js";
import { runBuildCommand } from "../../infra/build/runBuildCommand.js";
import { loadTwinConfig } from "../../infra/config/loadTwinConfig.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, HttpScenarioClient } from "../../infra/http/httpScenarioClient.js";
import { ProcessInstanceDriver } from "../../infra/process/processInstanceDriver.js";
import { runSetupCommand } from "../../infra/process/runSetupCommand.js";
import { snapshotSharedPaths } from "../../infra/sharedDisk/snapshotPaths.js";
import { HttpProxy } from "../../infra/proxy/httpProxy.js";
import { loadDotEnvFiles } from "../../infra/safety/loadDotEnvFiles.js";
import { loadSourceFilesForSafetyScan } from "../../infra/safety/loadSourceFiles.js";
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
  /** Run in the project before CONTROL and before SPLIT (e.g. a database reset). Falls back to twin.config.json's "setup". */
  setup?: string | undefined;
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
/** Replaced, in env values, with a directory every instance of this run shares. */
const SHARED_PLACEHOLDER = "{{shared}}";

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

    const configuredBuild = options.build ?? config?.build;
    const setup = options.setup ?? config?.setup;
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
    const dotEnvFiles = await loadDotEnvFiles(options.projectDir);
    const envSources = [
      ...dotEnvFiles.map((file) => ({ name: `${file.name} in the project`, vars: file.vars })),
      { name: "this shell's own environment", vars: process.env },
      { name: 'twin.config.json "env"', vars: config?.env ?? {} },
      { name: "--env", vars: options.env }
    ];
    const { env: mergedEnv, originOf } = mergeEnvSources(envSources);

    // Scanned per declared value rather than over mergedEnv: whichever source
    // loses the merge still holds a value the app might be the one to load, so
    // a placeholder must never be able to hide a real host declared elsewhere.
    // And the code itself: a connection string pasted into
    // `mongoose.connect("mongodb+srv://...")` never passes through any env.
    const sourceFiles = await loadSourceFilesForSafetyScan(
      options.projectDir,
      stackProfiles.flatMap((profile) => profile.sourceExtensions)
    );
    const envCandidates = collectEnvCandidates(envSources);
    const remoteRefs = [
      ...scanEnvCandidatesForRemoteResources(envCandidates, { allowedHosts }),
      ...scanSourceForRemoteResources(sourceFiles, { allowedHosts })
    ];
    if (remoteRefs.length > 0 && !allowRemote) {
      const list = remoteRefs.map((r) => `  ${r.key} -> ${r.host}   (set by ${r.source ?? originOf(r.key)})`).join("\n");
      const hosts = [...new Set(remoteRefs.map((r) => r.host))];
      throw new TwinError(
        "E_UNSAFE_ENV",
        `found what looks like a non-local database/service in the environment or the code:\n${list}`,
        {
          hint: `Twin would write test users/records into this real database. Point it at a local one, vouch for ${
            hosts.length === 1 ? "this host" : "these hosts"
          } with ${hosts.map((host) => `--allow-remote-host ${host}`).join(" ")}, or turn the check off entirely with --allow-remote.`,
          details: { remoteRefs: remoteRefs.map((ref) => ({ ...ref, source: ref.source ?? originOf(ref.key) })) }
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
    // Checked here rather than only in twin.config.json's validation, because
    // `--start ""` reaches this the same way and is not "unset": an empty
    // string won the `??` above, suppressed stack detection, and was handed to
    // a shell - which then reported itself as the app crashing on boot.
    if (explicitStart !== undefined && explicitStart.trim().length === 0) {
      throw new TwinError("E_CONFIG_INVALID", "the start command is empty", {
        hint: 'Pass a real command to --start (or "start" in twin.config.json), or leave it out entirely to let Twin detect it.'
      });
    }
    let stack: StackProfile;
    let start: string | undefined;
    let detectedStart: string | undefined;
    const build = configuredBuild;
    try {
      const detected = await detectStack(options.projectDir, options.stack ?? config?.stack);
      stack = detected.profile;
      detectedStart = detected.startCommand;
      start = explicitStart ?? detectedStart;
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
    // Only for the start command the stack itself chose (which is also what
    // `twin init` writes): compiling is that command's job, and says nothing
    // about one the user wrote - or about one whose build they configured.
    let compile: string | undefined;
    if (build === undefined && start === detectedStart && stack.compileTo !== undefined) {
      const output = quoteForShell(await prepareCompileOutput(options.projectDir, logger), process.platform);
      compile = stack.compileTo(output);
      start = output;
    }
    logger.info(`stack: ${stack.displayName}`, {
      start,
      ...(build !== undefined ? { build } : {}),
      ...(compile !== undefined ? { compile } : {})
    });

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

    // `{{shared}}` in an env value is this run's stand-in for the shared
    // volume or bucket production would give every instance - declared
    // shared, so writes there are the app working as designed.
    const usesShared = Object.values(env).some((value) => value.includes(SHARED_PLACEHOLDER));
    const sharedDir = usesShared ? await workspaceManager.sharedDir() : undefined;
    const instanceEnv =
      sharedDir === undefined
        ? env
        : Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value.split(SHARED_PLACEHOLDER).join(sharedDir)]));
    const declaredShared = [
      ...(sharedDir !== undefined ? [sharedDir] : []),
      ...(config?.sharedPaths ?? []).map((p) => path.resolve(options.projectDir, p))
    ];

    // Absolute paths in the env are on this machine's disk, which A and B
    // share here and two servers wouldn't. Said whenever there is one; the
    // snapshots around SPLIT below find out whether the app actually wrote there.
    const envPaths = localPathsInEnv(
      [
        ...dotEnvFiles.map((file) => ({ vars: file.vars, ambient: false })),
        { vars: process.env, ambient: true },
        { vars: instanceEnv, ambient: false }
      ],
      path.delimiter
    ).filter((p) => !declaredShared.some((root) => isWithin(p.path, root, path.sep, process.platform === "win32")));
    for (const { key, path: localPath } of envPaths) {
      logger.info(
        `note: ${key} is a path on this machine (${localPath}) - both instances share it here, but two servers or containers wouldn't. If it really is shared storage in production, list it in "sharedPaths" in twin.config.json`
      );
    }
    const sharedDiskPlan = {
      envPaths: envPaths.map((p) => p.path),
      // On Windows "/tmp" is "\tmp" on the current drive - and an instance's
      // current drive is the workspace's, under os.tmpdir(), which needn't be
      // Twin's (a CI checkout on D:, a temp dir on C:).
      tmpDirs: [
        ...new Set([
          os.tmpdir(),
          path.resolve("/tmp"),
          path.join(path.parse(os.tmpdir()).root, "tmp"),
          ...(process.platform === "win32" ? [] : ["/var/tmp"])
        ])
      ],
      exclude: [options.projectDir, path.join(os.tmpdir(), `twin-${run.id}`), ...declaredShared]
    };

    // HOST and BIND_ADDRESS default to 127.0.0.1, the only address Twin
    // connects to, so an app that reads one doesn't listen on the network.
    const startSpec = {
      command: start,
      build,
      portEnv,
      env: { ...loopbackHostEnv(mergedEnv, process.platform === "win32"), ...instanceEnv },
      healthPath,
      bootTimeoutMs
    };
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

    const runSetup = async (phase: string): Promise<void> => {
      if (setup === undefined) return;
      logger.info(`setup: running \`${setup}\` before ${phase}`);
      await runSetupCommand(setup, { cwd: options.projectDir, env: instanceEnv, phase, redactLine: redactLogLine });
    };
    // Every run writes real records through the app, into whatever database
    // it is configured with. Said up front when it has one: nothing else would
    // tell the user their dev database is accumulating test users. Said on
    // every run regardless, it was noise for apps without one - and noise
    // gets skipped, by the people it's for too.
    const datastores = findDatastoreSettings(envCandidates, sourceFiles, mergedEnv);
    if (setup === undefined && datastores.length > 0) {
      const named = `${datastores.slice(0, 3).join(", ")}${datastores.length > 3 ? ` and ${datastores.length - 3} more` : ""}`;
      logger.info(
        `note: the app is configured with a database (${named}) - the scenario writes real records to it, and Twin does not remove them. Point it at a throwaway one, or set "setup" (e.g. "npm run db:reset") to reset it before each phase`
      );
    }

    if (compile !== undefined) {
      // Once, for every instance and every restart, outside every boot
      // timeout - with the run's "env" and --env, which `go run` compiled with too.
      logger.info(`build: \`${compile}\``);
      await runBuildCommand(compile, {
        cwd: options.projectDir,
        target: "the project",
        env: { ...process.env, ...instanceEnv },
        redactLine: redactLogLine,
        hint: "Run it in the project to see the full error."
      });
    }

    await runSetup("CONTROL");
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

    await runSetup("SPLIT");
    logger.info("SPLIT: running the scenario against A + B behind the proxy");
    const diskBefore = await snapshotSharedPaths(sharedDiskPlan);
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

    // Written during SPLIT, outside both workspaces and outside anything
    // declared shared: a store A and B only share because they're on one disk.
    const writtenShared = changedPaths(diskBefore, await snapshotSharedPaths(sharedDiskPlan));
    if (writtenShared.length > 0) {
      logger.warn("both instances wrote to files outside their own workspaces, on a disk only this machine gives them", {
        paths: writtenShared
      });
    }

    const evaluated = markUnprovenByLocalDisk(
      evaluate({
        scenario,
        controlResults: control.results,
        splitResults: split.results,
        workspaceDiffs: split.workspaceDiffs,
        checks: builtInChecks,
        profile: PROFILE
      }),
      writtenShared
    );

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
