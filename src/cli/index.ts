#!/usr/bin/env node
import { Command } from "commander";

import { TwinError } from "../domain/errors.js";
import { ConsoleLogger } from "../infra/log/consoleLogger.js";
import { cleanOrphans } from "./commands/clean.js";
import { printDoctorReport, runDoctorChecks } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { reportCommand, type ReportFormat } from "./commands/report.js";
import { runCommand } from "./commands/run.js";

const logger = new ConsoleLogger();
const program = new Command();

/** Shared by every action that can throw a TwinError (run, report, ...): sets process.exitCode, never throws. */
async function runGuarded(action: () => Promise<number>): Promise<void> {
  try {
    process.exitCode = await action();
  } catch (err) {
    if (TwinError.isTwinError(err)) {
      logger.error(err.message, { code: err.code, ...(err.hint !== undefined ? { hint: err.hint } : {}) });
      process.exitCode = err.exitCode;
    } else {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 2;
    }
  }
}

program
  .name("twin")
  .description("Runs two copies of your app and shows you where they disagree.")
  .version("0.0.1");

program
  .command("doctor")
  .description("Check that your machine can run Twin")
  .action(() => {
    const ok = printDoctorReport(runDoctorChecks(), logger);
    process.exitCode = ok ? 0 : 1;
  });

program
  .command("clean")
  .description("Kill any orphaned instance processes left behind by a past run")
  .action(async () => {
    await cleanOrphans(process.cwd(), logger);
    process.exitCode = 0;
  });

function parseEnvFlag(value: string, previous: Record<string, string>): Record<string, string> {
  const eq = value.indexOf("=");
  if (eq === -1) {
    throw new Error(`--env expects KEY=VALUE, got "${value}"`);
  }
  return { ...previous, [value.slice(0, eq)]: value.slice(eq + 1) };
}

program
  .command("run")
  .description("Boot two instances of your app and check they behave the same")
  .option("--scenario <path>", "path to scenario.yaml (defaults to twin.config.json's \"scenario\")")
  .option("--project <dir>", "project directory to run", process.cwd())
  .option("--start <command>", 'start command (defaults to twin.config.json\'s "start", then auto-detection from package.json)')
  .option("--build <command>", "build command to run once per instance workspace before --start (e.g. for TypeScript/Next.js apps)")
  .option("--health-path <path>", 'path polled for readiness (default "/health")')
  .option("--port-env <name>", 'env var the app reads its port from (default "PORT")')
  .option("--boot-timeout-ms <ms>", "boot timeout per instance (default 60000)", (v: string) => Number(v))
  .option("--env <KEY=VALUE>", "extra env var for every instance (repeatable)", parseEnvFlag, {})
  .option("--keep-workspaces", "don't delete the per-instance tmp workspaces on exit", false)
  .option(
    "--allow-remote",
    "allow running even if a .env/process env var looks like a non-local database or service (I8) - off by default on purpose",
    false
  )
  .action(async (opts: {
    scenario?: string;
    project: string;
    start?: string;
    build?: string;
    healthPath?: string;
    portEnv?: string;
    bootTimeoutMs?: number;
    env: Record<string, string>;
    keepWorkspaces: boolean;
    allowRemote: boolean;
  }) => {
    await runGuarded(() =>
      runCommand(
        {
          projectDir: opts.project,
          scenarioPath: opts.scenario,
          start: opts.start,
          build: opts.build,
          healthPath: opts.healthPath,
          portEnv: opts.portEnv,
          bootTimeoutMs: opts.bootTimeoutMs,
          env: opts.env,
          keepWorkspaces: opts.keepWorkspaces,
          allowRemote: opts.allowRemote
        },
        logger
      )
    );
  });

program
  .command("report")
  .description("Re-print a past `twin run`'s report without re-running anything")
  .option("--project <dir>", "project directory the run happened in", process.cwd())
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
  .option("--project <dir>", "project directory to scaffold into", process.cwd())
  .option("--scenario <path>", "where to write the starter scenario", "scenario.yaml")
  .option("--force", "overwrite an existing scenario.yaml / twin.config.json", false)
  .action(async (opts: { project: string; scenario: string; force: boolean }) => {
    await runGuarded(async () => {
      await initCommand({ projectDir: opts.project, scenarioPath: opts.scenario, force: opts.force }, logger);
      return 0;
    });
  });

await program.parseAsync(process.argv);
