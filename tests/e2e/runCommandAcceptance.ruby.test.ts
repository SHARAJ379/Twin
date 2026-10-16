import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runCommand, type RunOptions } from "../../src/cli/commands/run.js";
import { ConsoleLogger } from "../../src/infra/log/consoleLogger.js";
import { runtimeMissing } from "./helpers/fixtureRequirements.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const brokenRubyDir = path.resolve(here, "../../examples/broken-ruby");
const fixedRubyDir = path.resolve(here, "../../examples/fixed-ruby");

const logger = new ConsoleLogger({ level: "error" }); // keep test output focused on assertion failures

const rubyMissing = runtimeMissing("Ruby", "ruby --version");

// Neither fixture has a Gemfile/config.ru marker (they're plain scripts on
// stdlib `socket`, with no gem dependencies to install), so the stack is
// passed explicitly rather than relying on auto-detection here.
const baseOptions: Omit<RunOptions, "projectDir" | "scenarioPath" | "env"> = {
  stack: "ruby",
  start: "ruby app.rb",
  healthPath: "/health",
  portEnv: "PORT",
  bootTimeoutMs: 30_000,
  keepWorkspaces: false,
  allowRemote: false
};

/**
 * Closes the "Ruby has not yet been run against a live app" gap called out
 * in the README: `twin run` end-to-end against a real Ruby app, broken and
 * fixed, the same acceptance shape as the Node fixtures.
 */
describe.skipIf(rubyMissing)("twin run against a live Ruby app: broken => FAIL, fixed => PASS", () => {
  const twinDirsToClean: string[] = [];

  afterEach(async () => {
    for (const dir of twinDirsToClean.splice(0)) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("FAILs all four checks against examples/broken-ruby, with the tracer attaching real suspects", async () => {
    twinDirsToClean.push(path.join(brokenRubyDir, ".twin"));
    const exitCode = await runCommand(
      { ...baseOptions, projectDir: brokenRubyDir, scenarioPath: path.join(brokenRubyDir, "scenario.yaml"), env: {} },
      logger
    );
    expect(exitCode).toBe(1);
  }, 150_000);

  it("PASSes all four checks against examples/fixed-ruby, given shared session secret/data/upload paths", async () => {
    twinDirsToClean.push(path.join(fixedRubyDir, ".twin"));
    const sharedDir = await mkdtemp(path.join(os.tmpdir(), "twin-fixed-ruby-shared-"));
    // Swept with the .twin dirs: `twin clean` deliberately only removes
    // Twin's own `twin-<run-id>` workspaces, so a fixture dir left here is
    // litter nothing else will ever collect.
    twinDirsToClean.push(sharedDir);
    const exitCode = await runCommand(
      {
        ...baseOptions,
        projectDir: fixedRubyDir,
        scenarioPath: path.join(fixedRubyDir, "scenario.yaml"),
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
