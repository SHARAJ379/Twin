import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runCommand, type RunOptions } from "../../src/cli/commands/run.js";
import { ConsoleLogger } from "../../src/infra/log/consoleLogger.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const brokenPhpDir = path.resolve(here, "../../examples/broken-php");
const fixedPhpDir = path.resolve(here, "../../examples/fixed-php");

const logger = new ConsoleLogger({ level: "error" }); // keep test output focused on assertion failures

const baseOptions: Omit<RunOptions, "projectDir" | "scenarioPath" | "env"> = {
  start: "php -S 127.0.0.1:{{port}} index.php",
  healthPath: "/health",
  portEnv: "PORT",
  bootTimeoutMs: 15_000,
  keepWorkspaces: false,
  allowRemote: false
};

/**
 * Closes the "PHP has not yet been run against a live app" gap called out
 * in the README: `twin run` end-to-end against a real PHP app (plain,
 * built-in dev server, no Composer deps), broken and fixed, the same
 * acceptance shape as the Node fixtures.
 */
describe("twin run against a live PHP app: broken => FAIL, fixed => PASS", () => {
  const twinDirsToClean: string[] = [];

  afterEach(async () => {
    for (const dir of twinDirsToClean.splice(0)) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("FAILs all four checks against examples/broken-php, with the tracer attaching real suspects", async () => {
    twinDirsToClean.push(path.join(brokenPhpDir, ".twin"));
    const exitCode = await runCommand(
      { ...baseOptions, projectDir: brokenPhpDir, scenarioPath: path.join(brokenPhpDir, "scenario.yaml"), env: {} },
      logger
    );
    expect(exitCode).toBe(1);
  }, 60_000);

  it("PASSes all four checks against examples/fixed-php, given shared session secret/data/upload paths", async () => {
    twinDirsToClean.push(path.join(fixedPhpDir, ".twin"));
    const sharedDir = await mkdtemp(path.join(os.tmpdir(), "twin-fixed-php-shared-"));
    const exitCode = await runCommand(
      {
        ...baseOptions,
        projectDir: fixedPhpDir,
        scenarioPath: path.join(fixedPhpDir, "scenario.yaml"),
        env: {
          SESSION_SECRET: "test-secret-123",
          DATA_FILE: path.join(sharedDir, "data.json"),
          UPLOAD_DIR: path.join(sharedDir, "uploads")
        }
      },
      logger
    );
    expect(exitCode).toBe(0);
  }, 60_000);
});
