import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runCommand, type RunOptions } from "../../src/cli/commands/run.js";
import { compiledBinaryPath } from "../../src/domain/compiledBinary.js";
import { quoteForShell } from "../../src/domain/shellQuote.js";
import { ConsoleLogger } from "../../src/infra/log/consoleLogger.js";
import type { Logger } from "../../src/ports/logger.js";
import { runtimeMissing } from "./helpers/fixtureRequirements.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const brokenGoDir = path.resolve(here, "../../examples/broken-go");
const fixedGoDir = path.resolve(here, "../../examples/fixed-go");

const quiet = new ConsoleLogger({ level: "error" }); // keep test output focused on assertion failures

/** Quiet, but keeps what the run said it would start the app with - the "stack:" line. */
function recordingStack(): { logger: Logger; stack: () => Record<string, unknown> | undefined } {
  let stack: Record<string, unknown> | undefined;
  const logger: Logger = {
    debug: () => {},
    info: (message, meta) => {
      if (message.startsWith("stack:")) stack = meta;
    },
    warn: (message, meta) => quiet.warn(message, meta),
    error: (message, meta) => quiet.error(message, meta),
    child: () => logger
  };
  return { logger, stack: () => stack };
}

/**
 * Where every run of this project compiles to, and starts from. `go run .`
 * linked a new executable into a new temp folder for every instance, every
 * run, and Windows Firewall asked about each one ("allow public and private
 * networks to access this app? (broken-go)") - three prompts per run.
 */
function compiledFrom(projectDir: string): { binary: string; start: string; compile: string } {
  const binary = compiledBinaryPath({ projectDir, platform: process.platform, env: process.env, homedir: os.homedir() });
  const start = quoteForShell(binary, process.platform);
  return { binary, start, compile: `go build -o ${start} .` };
}

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
    const { logger, stack } = recordingStack();
    const exitCode = await runCommand(
      { ...baseOptions, projectDir: brokenGoDir, scenarioPath: path.join(brokenGoDir, "scenario.yaml"), env: {} },
      logger
    );
    expect(exitCode).toBe(1);
    // "go run ." is what `twin init` writes, so it's still compiled once and started as an executable.
    const expected = compiledFrom(brokenGoDir);
    expect(stack()).toMatchObject({ start: expected.start, compile: expected.compile });
    expect(existsSync(expected.binary)).toBe(true);
  }, 150_000);

  // As shipped: no flags, no env. Its twin.config.json points every instance
  // at {{shared}}, the run's stand-in for a shared volume (examples/README.md).
  it("PASSes all four checks against examples/fixed-go with no extra flags", async () => {
    twinDirsToClean.push(path.join(fixedGoDir, ".twin"));
    const { logger, stack } = recordingStack();
    const exitCode = await runCommand({ projectDir: fixedGoDir, env: {}, keepWorkspaces: false, allowRemote: false }, logger);
    expect(exitCode).toBe(0);
    expect(stack()).toMatchObject({ start: compiledFrom(fixedGoDir).start });
  }, 150_000);
});

/**
 * Found by CI (windows-latest, Node 20): once a boot timeout stopped being
 * retried, `go run .` on a cold runner spent the whole 30s timeout compiling,
 * and the control instance "never became healthy". Twin now compiles Go apps
 * once, before CONTROL, where no boot timeout counts it.
 */
describe.skipIf(goMissing)("a Go app whose first compile takes longer than the boot timeout", () => {
  let gocache: string;
  const savedGocache = process.env.GOCACHE;

  afterEach(async () => {
    if (savedGocache === undefined) delete process.env.GOCACHE;
    else process.env.GOCACHE = savedGocache;
    await rm(gocache, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(path.join(brokenGoDir, ".twin"), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("still boots, with the compile moved out of the boot timeout - to the same executable as any other run", async () => {
    // An empty build cache: the first compile is a cold one (~10s locally,
    // longer on a CI runner), well past the 5s given to boot.
    gocache = await mkdtemp(path.join(os.tmpdir(), "twin-gocache-"));
    process.env.GOCACHE = gocache;

    const { logger, stack } = recordingStack();
    const exitCode = await runCommand(
      { ...baseOptions, bootTimeoutMs: 5_000, projectDir: brokenGoDir, scenarioPath: path.join(brokenGoDir, "scenario.yaml"), env: {} },
      logger
    );
    // Booted and judged - broken-go's real bugs - rather than E_BOOT_TIMEOUT.
    expect(exitCode).toBe(1);
    // A cold cache rebuilt it from scratch, into the very path the run above used.
    expect(stack()).toMatchObject({ start: compiledFrom(brokenGoDir).start });
  }, 300_000);
});
