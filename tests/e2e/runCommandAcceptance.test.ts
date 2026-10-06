import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runCommand, type RunOptions } from "../../src/cli/commands/run.js";
import { ConsoleLogger } from "../../src/infra/log/consoleLogger.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const brokenExpressDir = path.resolve(here, "../../examples/broken-express");
const fixedExpressDir = path.resolve(here, "../../examples/fixed-express");

const logger = new ConsoleLogger({ level: "error" }); // keep test output focused on assertion failures

const baseOptions: Omit<RunOptions, "projectDir" | "scenarioPath" | "env"> = {
  start: "npm start",
  healthPath: "/health",
  portEnv: "PORT",
  bootTimeoutMs: 15_000,
  keepWorkspaces: false
};

/**
 * Milestone 4 acceptance test (TWIN_ARCHITECTURE.md §16.4): `twin run`
 * end-to-end against the two example apps and a deliberately typo'd
 * scenario - exactly "broken => FAIL, fixed => PASS, typo scenario => ERROR".
 */
describe("twin run: broken => FAIL, fixed => PASS, typo scenario => ERROR", () => {
  const twinDirsToClean: string[] = [];

  afterEach(async () => {
    for (const dir of twinDirsToClean.splice(0)) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("FAILs both checks against examples/broken-express", async () => {
    twinDirsToClean.push(path.join(brokenExpressDir, ".twin"));
    const exitCode = await runCommand(
      { ...baseOptions, projectDir: brokenExpressDir, scenarioPath: path.join(brokenExpressDir, "scenario.yaml"), env: {} },
      logger
    );
    expect(exitCode).toBe(1);
  }, 40_000);

  it("PASSes both checks against examples/fixed-express, given a shared session secret and data file", async () => {
    twinDirsToClean.push(path.join(fixedExpressDir, ".twin"));
    const dataFile = path.join(await mkdtemp(path.join(os.tmpdir(), "twin-fixed-data-")), "data.json");
    const exitCode = await runCommand(
      {
        ...baseOptions,
        projectDir: fixedExpressDir,
        scenarioPath: path.join(fixedExpressDir, "scenario.yaml"),
        env: { SESSION_SECRET: "test-secret-123", DATA_FILE: dataFile }
      },
      logger
    );
    expect(exitCode).toBe(0);
  }, 40_000);

  it("ERRORs (never FAILs) on a scenario typo - the control run fails on its own, so I7 blocks a FAIL verdict", async () => {
    twinDirsToClean.push(path.join(brokenExpressDir, ".twin"));
    const exitCode = await runCommand(
      { ...baseOptions, projectDir: brokenExpressDir, scenarioPath: path.join(brokenExpressDir, "scenario-typo.yaml"), env: {} },
      logger
    );
    expect(exitCode).toBe(2);
  }, 40_000);
});
