import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TwinError } from "../../domain/errors.js";
import { ConsoleLogger } from "../../infra/log/consoleLogger.js";
import { runCommand, type RunOptions } from "./run.js";

const logger = new ConsoleLogger({ level: "error" });

describe("runCommand PREFLIGHT failures", () => {
  let projectDir: string;

  afterEach(async () => {
    if (projectDir !== undefined) await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const baseOptions: Omit<RunOptions, "projectDir" | "scenarioPath" | "env"> = {
    start: "npm start",
    healthPath: "/health",
    portEnv: "PORT",
    bootTimeoutMs: 15_000,
    keepWorkspaces: false
  };

  it("rejects with E_SCENARIO_INVALID for a scenario that fails schema validation, without booting anything", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-preflight-"));
    const scenarioPath = path.join(projectDir, "scenario.yaml");
    await writeFile(scenarioPath, "name: x\nversion: 1\nsteps:\n  - id: a\n    kind: request\n", "utf8"); // missing `request`

    const err = await runCommand({ ...baseOptions, projectDir, scenarioPath, env: {} }, logger).catch((e: unknown) => e);

    expect(TwinError.isTwinError(err)).toBe(true);
    expect((err as TwinError).code).toBe("E_SCENARIO_INVALID");
  });

  it("rejects with E_SCENARIO_INVALID when the scenario file doesn't exist", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-preflight-"));
    const err = await runCommand(
      { ...baseOptions, projectDir, scenarioPath: path.join(projectDir, "missing.yaml"), env: {} },
      logger
    ).catch((e: unknown) => e);

    expect(TwinError.isTwinError(err)).toBe(true);
    expect((err as TwinError).code).toBe("E_SCENARIO_INVALID");
  });
});
