#!/usr/bin/env node
import { createRequire } from "node:module";

import { Command, InvalidArgumentError, Option } from "commander";

import { TwinError } from "../domain/errors.js";
import { createLogRedactor } from "../domain/logRedaction.js";
import { stackIds } from "../domain/stacks/index.js";
import { ConsoleLogger } from "../infra/log/consoleLogger.js";
import { RedactingLogger } from "../infra/log/redactingLogger.js";
import { cleanOrphans } from "./commands/clean.js";
import { printDoctorReport, runDoctorChecks } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { reportCommand, type ReportFormat } from "./commands/report.js";
import { runCommand } from "./commands/run.js";
import { installShutdownHandlers } from "./shutdown.js";

// Everything any command logs is masked on the way out, so a password or
// token written into a command, a config value or an error never reaches the
// terminal - or the CI log that keeps it. `twin run` adds the env's own
// secret values on top (see runCommand).
const redactLine = createLogRedactor();
const logger = new RedactingLogger(new ConsoleLogger(), redactLine);
const program = new Command();

// Before any command runs: Ctrl-C must stop the instances it started and
// remove their workspaces, not leave them for `twin clean` to find later.
installShutdownHandlers(logger);

/** Shared by every action that can throw a TwinError (run, report, ...): sets process.exitCode, never throws. */
async function runGuarded(action: () => Promise<number>): Promise<void> {
  try {
    process.exitCode = await action();
  } catch (err) {
    if (TwinError.isTwinError(err)) {
      logger.error(err.message, { code: err.code, ...(err.hint !== undefined ? { hint: err.hint } : {}) });
      // The app's own output is usually the whole diagnosis for a boot
      // failure, so print it rather than burying it in details.
      const logTail = err.details?.logTail;
      if (Array.isArray(logTail) && logTail.length > 0) {
        console.error(`\n--- last ${logTail.length} line(s) from the app ---`);
        for (const line of logTail) console.error(redactLine(String(line)));
        console.error("---");
      }
      process.exitCode = err.exitCode;
    } else {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 2;
    }
  }
}

// Read from package.json rather than hardcoding: a second copy of the version
// here would silently drift from the published one on the next release.
const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

program
  .name("twin")
  .description("Runs two copies of your app and shows you where they disagree.")
  .version(version);

program
  .command("doctor")
  .description("Check that your machine can run Twin")
  .action(() => {
    const ok = printDoctorReport(runDoctorChecks(), logger);
    process.exitCode = ok ? 0 : 1;
  });

program
  .command("clean")
  .description("Kill any orphaned instance processes, and remove the temp workspaces, left behind by a past run")
  .addOption(projectOption("project directory to clean"))
  .option("--unlock", "also remove the project's lock even if its holder can't be ruled out - only when no Twin run is in progress", false)
  .action(async (opts: { project: string; unlock: boolean }) => {
    await runGuarded(async () => {
      await cleanOrphans(opts.project, logger, undefined, { unlock: opts.unlock });
      return 0;
    });
  });

/** `--project`, defaulting to where Twin was run - shown as that in --help, not as one machine's absolute path. */
function projectOption(description: string): Option {
  return new Option("--project <dir>", description).default(process.cwd(), "the current directory");
}

/** Number("abc") is NaN, which would reach AbortSignal.timeout() and fail far from the typo that caused it. */
function parseMilliseconds(flag: string): (value: string) => number {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new InvalidArgumentError(`${flag} must be a positive whole number of milliseconds, got "${value}"`);
    }
    return parsed;
  };
}

function collectFlag(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseEnvFlag(value: string, previous: Record<string, string>): Record<string, string> {
  const eq = value.indexOf("=");
  if (eq === -1) {
    // InvalidArgumentError, not Error: commander catches this one and prints
    // the usage error with the flag's name, where a plain Error escapes as an
    // unhandled rejection with a stack trace over a typo.
    throw new InvalidArgumentError(`--env expects KEY=VALUE, got "${value}"`);
  }
  return { ...previous, [value.slice(0, eq)]: value.slice(eq + 1) };
}

program
  .command("run")
  .description("Boot two instances of your app and check they behave the same")
  .option("--scenario <path>", "path to scenario.yaml (defaults to twin.config.json's \"scenario\")")
  .addOption(projectOption("project directory to run"))
  .option("--stack <id>", `language stack: ${stackIds.join(", ")} (default: detected from marker files)`)
  .option(
    "--start <command>",
    'start command (defaults to twin.config.json\'s "start", then the stack\'s own detection). `{{port}}` is replaced with the port Twin assigns'
  )
  .option("--build <command>", "build command to run once per instance workspace before --start (e.g. for TypeScript/Next.js apps)")
  .option(
    "--setup <command>",
    "run in the project before CONTROL and before SPLIT, e.g. a throwaway database's reset (defaults to twin.config.json's \"setup\")"
  )
  .option("--health-path <path>", 'path polled for readiness (default "/health")')
  .option("--port-env <name>", 'env var the app reads its port from (default "PORT")')
  .option("--boot-timeout-ms <ms>", "boot timeout per instance (default 60000)", parseMilliseconds("--boot-timeout-ms"))
  .option(
    "--request-timeout-ms <ms>",
    "deadline for a single scenario request (default 30000) - bounds the whole run so a hung app can't stall it",
    parseMilliseconds("--request-timeout-ms")
  )
  .option(
    "--redact-header <name>",
    "also redact this response/request header from the report (repeatable)",
    collectFlag,
    []
  )
  .option("--env <KEY=VALUE>", "extra env var for every instance (repeatable)", parseEnvFlag, {})
  .option("--keep-workspaces", "don't delete the per-instance tmp workspaces on exit", false)
  .option(
    "--allow-remote",
    "run even if the environment or the code points at what looks like a real (non-local) database or service - off by default on purpose",
    false
  )
  .option(
    "--allow-remote-host <host>",
    "vouch for one host instead of turning the whole check off; a leading dot is a domain suffix (repeatable)",
    collectFlag,
    []
  )
  .action(async (opts: {
    scenario?: string;
    project: string;
    stack?: string;
    start?: string;
    build?: string;
    setup?: string;
    healthPath?: string;
    portEnv?: string;
    bootTimeoutMs?: number;
    requestTimeoutMs?: number;
    redactHeader: string[];
    env: Record<string, string>;
    keepWorkspaces: boolean;
    allowRemote: boolean;
    allowRemoteHost: string[];
  }) => {
    await runGuarded(() =>
      runCommand(
        {
          projectDir: opts.project,
          scenarioPath: opts.scenario,
          stack: opts.stack,
          start: opts.start,
          build: opts.build,
          setup: opts.setup,
          healthPath: opts.healthPath,
          portEnv: opts.portEnv,
          bootTimeoutMs: opts.bootTimeoutMs,
          requestTimeoutMs: opts.requestTimeoutMs,
          redactHeaders: opts.redactHeader,
          env: opts.env,
          keepWorkspaces: opts.keepWorkspaces,
          allowRemote: opts.allowRemote,
          allowRemoteHosts: opts.allowRemoteHost
        },
        logger
      )
    );
  });

program
  .command("report")
  .description("Re-print a past `twin run`'s report without re-running anything")
  .addOption(projectOption("project directory the run happened in"))
  .option("--run <id>", "a specific run id (defaults to the most recent run)")
  .option("--format <format>", "terminal, json, or markdown", "terminal")
  .action(async (opts: { project: string; run?: string; format: string }) => {
    if (opts.format !== "terminal" && opts.format !== "json" && opts.format !== "markdown") {
      logger.error(`--format must be "terminal", "json", or "markdown", got "${opts.format}"`);
      process.exitCode = 2;
      return;
    }
    await runGuarded(() =>
      reportCommand({ projectDir: opts.project, run: opts.run, format: opts.format as ReportFormat }, (text) => console.log(text))
    );
  });

program
  .command("init")
  .description("Scaffold a starter scenario.yaml and twin.config.json")
  .addOption(projectOption("project directory to scaffold into"))
  .option("--scenario <path>", "where to write the starter scenario", "scenario.yaml")
  .option("--force", "overwrite an existing scenario.yaml / twin.config.json", false)
  .action(async (opts: { project: string; scenario: string; force: boolean }) => {
    await runGuarded(async () => {
      await initCommand({ projectDir: opts.project, scenarioPath: opts.scenario, force: opts.force }, logger);
      return 0;
    });
  });

await program.parseAsync(process.argv);
