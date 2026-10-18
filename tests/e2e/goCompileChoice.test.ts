import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCommand, type RunOptions } from "../../src/cli/commands/run.js";
import { compiledBinaryPath } from "../../src/domain/compiledBinary.js";
import { ConsoleLogger } from "../../src/infra/log/consoleLogger.js";
import type { Logger } from "../../src/ports/logger.js";

const quiet = new ConsoleLogger({ level: "error" });

function recordingStack(): { logger: Logger; stack: () => Record<string, unknown> | undefined } {
  let stack: Record<string, unknown> | undefined;
  const logger: Logger = {
    debug: () => {},
    info: (message, meta) => {
      if (message.startsWith("stack:")) stack = meta;
    },
    warn: () => {},
    error: (message, meta) => quiet.error(message, meta),
    child: () => logger
  };
  return { logger, stack: () => stack };
}

const APP = `
require("node:http").createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(req.url === "/health" ? { ok: true } : { user: "alice" }));
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

const SCENARIO = `name: choice
version: 1
steps:
  - id: me
    kind: request
    request: { method: GET, path: /me }
    expect: { status: 200 }
    check: session-survives-switch
`;

/**
 * Twin compiles a Go app itself only for the start command it detected:
 * compiling is that command's job. A start command or a build of the user's
 * own says how they want it built and run, so Twin leaves both alone - and
 * compiles nothing, anywhere.
 */
describe("when Twin compiles a Go app itself", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "go-choice-fixture-"));
    await writeFile(path.join(projectDir, "go.mod"), "module example.com/choice\n\ngo 1.22\n", "utf8");
    await writeFile(path.join(projectDir, "server.js"), APP, "utf8");
    await writeFile(path.join(projectDir, "scenario.yaml"), SCENARIO, "utf8");
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const options = (extra: Partial<RunOptions>): RunOptions => ({
    projectDir,
    scenarioPath: path.join(projectDir, "scenario.yaml"),
    env: {},
    bootTimeoutMs: 30_000,
    keepWorkspaces: false,
    allowRemote: false,
    ...extra
  });
  const compiledDir = (): string =>
    path.dirname(compiledBinaryPath({ projectDir, platform: process.platform, env: process.env, homedir: os.homedir() }));

  it("doesn't, for a start command of your own", async () => {
    const { logger, stack } = recordingStack();
    expect(await runCommand(options({ start: "node server.js" }), logger)).toBe(0);
    expect(stack()).toEqual({ start: "node server.js" });
    expect(existsSync(compiledDir())).toBe(false);
  }, 90_000);

  it("doesn't, when you configured a build - your build, then the detected `go run .`, as you'd expect", async () => {
    const { logger, stack } = recordingStack();
    // There's no Go code here, so `go run .` itself fails to boot; what matters is what Twin chose to run.
    await runCommand(options({ build: 'node -e "0"', bootTimeoutMs: 5_000 }), logger).catch(() => undefined);
    expect(stack()).toEqual({ start: "go run .", build: 'node -e "0"' });
    expect(existsSync(compiledDir())).toBe(false);
  }, 90_000);
});
