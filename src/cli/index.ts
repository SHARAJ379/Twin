#!/usr/bin/env node
import { Command } from "commander";

import { ConsoleLogger } from "../infra/log/consoleLogger.js";
import { printDoctorReport, runDoctorChecks } from "./commands/doctor.js";

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

// Placeholders for the rest of the CLI surface (TWIN_ARCHITECTURE.md §2, §16) —
// registered now so the command surface is stable; wired up milestone by milestone.
for (const name of ["init", "run", "report", "clean"] as const) {
  program
    .command(name)
    .description("not implemented yet")
    .action(() => {
      logger.error(`\`twin ${name}\` isn't built yet.`);
      process.exitCode = 1;
    });
}

await program.parseAsync(process.argv);
