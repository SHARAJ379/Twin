#!/usr/bin/env node
import { Command } from "commander";

import { TwinError } from "../domain/errors.js";
import { ConsoleLogger } from "../infra/log/consoleLogger.js";
import { cleanOrphans } from "./commands/clean.js";
import { printDoctorReport, runDoctorChecks } from "./commands/doctor.js";
import { runCommand } from "./commands/run.js";

const logger = new ConsoleLogger();
const program = new Command();

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
  .requiredOption("--scenario <path>", "path to scenario.yaml")
  .option("--project <dir>", "project directory to run", process.cwd())
  .option("--start <command>", "start command", "npm start")
  .option("--health-path <path>", "path polled for readiness", "/health")
  .option("--port-env <name>", "env var the app reads its port from", "PORT")
  .option("--boot-timeout-ms <ms>", "boot timeout per instance", (v: string) => Number(v), 60_000)
  .option("--env <KEY=VALUE>", "extra env var for every instance (repeatable)", parseEnvFlag, {})
  .option("--keep-workspaces", "don't delete the per-instance tmp workspaces on exit", false)
  .option(
    "--allow-remote",
    "allow running even if a .env/process env var looks like a non-local database or service (I8) - off by default on purpose",
    false
  )
  .action(async (opts: {
    scenario: string;
    project: string;
    start: string;
    healthPath: string;
    portEnv: string;
    bootTimeoutMs: number;
    env: Record<string, string>;
    keepWorkspaces: boolean;
    allowRemote: boolean;
  }) => {
    try {
      process.exitCode = await runCommand(
        {
          projectDir: opts.project,
          scenarioPath: opts.scenario,
          start: opts.start,
          healthPath: opts.healthPath,
          portEnv: opts.portEnv,
          bootTimeoutMs: opts.bootTimeoutMs,
          env: opts.env,
          keepWorkspaces: opts.keepWorkspaces,
          allowRemote: opts.allowRemote
        },
        logger
      );
    } catch (err) {
      if (TwinError.isTwinError(err)) {
        logger.error(err.message, { code: err.code, ...(err.hint !== undefined ? { hint: err.hint } : {}) });
        process.exitCode = err.exitCode;
      } else {
        logger.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 2;
      }
    }
  });

// Placeholders for the rest of the CLI surface (TWIN_ARCHITECTURE.md §2, §16) —
// registered now so the command surface is stable; wired up milestone by milestone.
for (const name of ["init", "report"] as const) {
  program
    .command(name)
    .description("not implemented yet")
    .action(() => {
      logger.error(`\`twin ${name}\` isn't built yet.`);
      process.exitCode = 1;
    });
}

await program.parseAsync(process.argv);
