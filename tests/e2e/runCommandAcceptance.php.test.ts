import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runCommand, type RunOptions } from "../../src/cli/commands/run.js";
import { ConsoleLogger } from "../../src/infra/log/consoleLogger.js";
import { expectBrokenExampleReport, expectFixedExampleReport } from "./helpers/exampleReport.js";
import { runtimeMissing } from "./helpers/fixtureRequirements.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const brokenPhpDir = path.resolve(here, "../../examples/broken-php");
const fixedPhpDir = path.resolve(here, "../../examples/fixed-php");

const logger = new ConsoleLogger({ level: "error" }); // keep test output focused on assertion failures

const phpMissing = runtimeMissing("PHP", "php --version");

const baseOptions: Omit<RunOptions, "projectDir" | "scenarioPath" | "env"> = {
  start: "php -S 127.0.0.1:{{port}} index.php",
  healthPath: "/health",
  portEnv: "PORT",
  bootTimeoutMs: 30_000,
  keepWorkspaces: false,
  allowRemote: false
};

/**
 * Closes the "PHP has not yet been run against a live app" gap called out
 * in the README: `twin run` end-to-end against a real PHP app (plain,
 * built-in dev server, no Composer deps), broken and fixed, the same
 * acceptance shape as the Node fixtures.
 */
describe.skipIf(phpMissing)("twin run against a live PHP app: broken => FAIL, fixed => PASS", () => {
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
    await expectBrokenExampleReport(brokenPhpDir);
  }, 150_000);

  // As shipped: no flags, no env. Its twin.config.json points every instance
  // at {{shared}}, the run's stand-in for a shared volume (examples/README.md).
  it("PASSes all four checks against examples/fixed-php with no extra flags", async () => {
    twinDirsToClean.push(path.join(fixedPhpDir, ".twin"));
    const exitCode = await runCommand({ projectDir: fixedPhpDir, env: {}, keepWorkspaces: false, allowRemote: false }, logger);
    expect(exitCode).toBe(0);
    await expectFixedExampleReport(fixedPhpDir);
  }, 150_000);
});

/**
 * Found in the pre-release audit: the PHP stack left `storage/` out of every
 * workspace, and Laravel won't boot without storage/framework/views - its
 * view compiler answers "Please provide a valid cache path." Every Laravel
 * app came back E_BOOT_TIMEOUT, with a hint about the health path.
 */
describe.skipIf(phpMissing)("a Laravel-shaped app that needs its storage/ directory", () => {
  let projectDir: string;

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("boots, because storage/ is copied into each instance's workspace", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "laravel-shape-"));
    await writeFile(path.join(projectDir, "composer.json"), "{}\n", "utf8");
    await mkdir(path.join(projectDir, "public"));
    await writeFile(
      path.join(projectDir, "public", "index.php"),
      [
        "<?php",
        "if (realpath(__DIR__ . '/../storage/framework/views') === false) {",
        "  http_response_code(500);",
        "  echo 'Please provide a valid cache path.';",
        "  exit;",
        "}",
        "header('Content-Type: application/json');",
        "echo json_encode(['ok' => true]);",
        ""
      ].join("\n"),
      "utf8"
    );
    await mkdir(path.join(projectDir, "storage", "framework", "views"), { recursive: true });
    await writeFile(path.join(projectDir, "storage", "framework", "views", ".gitignore"), "*\n!.gitignore\n", "utf8");
    await writeFile(
      path.join(projectDir, "scenario.yaml"),
      "name: laravel-shape\nversion: 1\nsteps:\n  - id: me\n    kind: request\n    request: { method: GET, path: /me }\n    expect: { status: 200 }\n    check: session-survives-switch\n",
      "utf8"
    );

    // No start command: `php -S ... -t public public/index.php` is detected from public/.
    const exitCode = await runCommand(
      { projectDir, scenarioPath: path.join(projectDir, "scenario.yaml"), env: {}, bootTimeoutMs: 15_000, keepWorkspaces: false, allowRemote: false },
      logger
    );
    expect(exitCode).toBe(0);
  }, 150_000);
});
