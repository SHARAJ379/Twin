import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runCommand, type RunOptions } from "../../src/cli/commands/run.js";
import { ConsoleLogger } from "../../src/infra/log/consoleLogger.js";
import { runtimeMissing } from "./helpers/fixtureRequirements.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const brokenPythonDir = path.resolve(here, "../../examples/broken-python");
const fixedPythonDir = path.resolve(here, "../../examples/fixed-python");

const logger = new ConsoleLogger({ level: "error" }); // keep test output focused on assertion failures

const pythonMissing = runtimeMissing("Python", "python --version");

const baseOptions: Omit<RunOptions, "projectDir" | "scenarioPath" | "env"> = {
  start: "python app.py",
  healthPath: "/health",
  portEnv: "PORT",
  bootTimeoutMs: 15_000,
  keepWorkspaces: false,
  allowRemote: false
};

/**
 * Closes the "Python has not yet been run against a live app" gap called
 * out in the README: `twin run` end-to-end against a real Python app
 * (stdlib http.server, no pip deps), broken and fixed, the same
 * acceptance shape as the Node fixtures.
 */
describe.skipIf(pythonMissing)("twin run against a live Python app: broken => FAIL, fixed => PASS", () => {
  const twinDirsToClean: string[] = [];

  afterEach(async () => {
    for (const dir of twinDirsToClean.splice(0)) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("FAILs all four checks against examples/broken-python, with the tracer attaching real suspects", async () => {
    twinDirsToClean.push(path.join(brokenPythonDir, ".twin"));
    const exitCode = await runCommand(
      { ...baseOptions, projectDir: brokenPythonDir, scenarioPath: path.join(brokenPythonDir, "scenario.yaml"), env: {} },
      logger
    );
    expect(exitCode).toBe(1);
  }, 60_000);

  it("PASSes all four checks against examples/fixed-python, given shared session secret/data/upload paths", async () => {
    twinDirsToClean.push(path.join(fixedPythonDir, ".twin"));
    const sharedDir = await mkdtemp(path.join(os.tmpdir(), "twin-fixed-python-shared-"));
    const exitCode = await runCommand(
      {
        ...baseOptions,
        projectDir: fixedPythonDir,
        scenarioPath: path.join(fixedPythonDir, "scenario.yaml"),
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
