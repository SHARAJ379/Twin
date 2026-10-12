import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runCommand, type RunOptions } from "../../src/cli/commands/run.js";
import { ConsoleLogger } from "../../src/infra/log/consoleLogger.js";
import { runtimeMissing } from "./helpers/fixtureRequirements.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const brokenGoDir = path.resolve(here, "../../examples/broken-go");
const fixedGoDir = path.resolve(here, "../../examples/fixed-go");

const logger = new ConsoleLogger({ level: "error" }); // keep test output focused on assertion failures

const goMissing = runtimeMissing("Go", "go version");

const baseOptions: Omit<RunOptions, "projectDir" | "scenarioPath" | "env"> = {
  start: "go run .",
  healthPath: "/health",
  portEnv: "PORT",
  bootTimeoutMs: 30_000,
  keepWorkspaces: false,
  allowRemote: false
};

/**
 * Closes the "Go has not yet been run against a live app" gap called out in
 * the README: `twin run` end-to-end against a real Go net/http app, broken
 * and fixed, the same acceptance shape as the Node fixtures.
 */
describe.skipIf(goMissing)("twin run against a live Go app: broken => FAIL, fixed => PASS", () => {
  const twinDirsToClean: string[] = [];

  afterEach(async () => {
    for (const dir of twinDirsToClean.splice(0)) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("FAILs all four checks against examples/broken-go, with the tracer attaching real suspects", async () => {
    twinDirsToClean.push(path.join(brokenGoDir, ".twin"));
    const exitCode = await runCommand(
      { ...baseOptions, projectDir: brokenGoDir, scenarioPath: path.join(brokenGoDir, "scenario.yaml"), env: {} },
      logger
    );
    expect(exitCode).toBe(1);
  }, 150_000);

  it("PASSes all four checks against examples/fixed-go, given shared session secret/data/upload paths", async () => {
    twinDirsToClean.push(path.join(fixedGoDir, ".twin"));
    const sharedDir = await mkdtemp(path.join(os.tmpdir(), "twin-fixed-go-shared-"));
    const exitCode = await runCommand(
      {
        ...baseOptions,
        projectDir: fixedGoDir,
        scenarioPath: path.join(fixedGoDir, "scenario.yaml"),
        env: {
          SESSION_SECRET: "test-secret-123",
          DATA_FILE: path.join(sharedDir, "data.json"),
          UPLOAD_DIR: path.join(sharedDir, "uploads")
        }
      },
      logger
    );
    expect(exitCode).toBe(0);
  }, 150_000);
});
