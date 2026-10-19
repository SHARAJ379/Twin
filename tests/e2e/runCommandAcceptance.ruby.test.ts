import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runCommand, type RunOptions } from "../../src/cli/commands/run.js";
import { ConsoleLogger } from "../../src/infra/log/consoleLogger.js";
import { expectBrokenExampleReport, expectFixedExampleReport } from "./helpers/exampleReport.js";
import { runtimeMissing } from "./helpers/fixtureRequirements.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const brokenRubyDir = path.resolve(here, "../../examples/broken-ruby");
const fixedRubyDir = path.resolve(here, "../../examples/fixed-ruby");

const logger = new ConsoleLogger({ level: "error" }); // keep test output focused on assertion failures

const rubyMissing = runtimeMissing("Ruby", "ruby --version");

// Neither fixture has a Gemfile/config.ru (they're plain scripts on stdlib
// `socket`, with no gems to install). No stack or start command is passed:
// detecting `app.rb` and guessing `ruby app.rb` is part of what's under
// test - forcing both here is how the examples shipped undetectable.
const baseOptions: Omit<RunOptions, "projectDir" | "scenarioPath" | "env"> = {
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
    await expectBrokenExampleReport(brokenRubyDir);
  }, 150_000);

  // As shipped: no flags, no env. Its twin.config.json points every instance
  // at {{shared}}, the run's stand-in for a shared volume (examples/README.md).
  it("PASSes all four checks against examples/fixed-ruby with no extra flags", async () => {
    twinDirsToClean.push(path.join(fixedRubyDir, ".twin"));
    const exitCode = await runCommand({ projectDir: fixedRubyDir, env: {}, keepWorkspaces: false, allowRemote: false }, logger);
    expect(exitCode).toBe(0);
    await expectFixedExampleReport(fixedRubyDir);
  }, 150_000);
});
