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
    keepWorkspaces: false,
    allowRemote: false
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

  const trivialScenarioYaml = "name: x\nversion: 1\nsteps:\n  - id: a\n    kind: wait\n    ms: 1\n";

  it("rejects with E_UNSAFE_ENV when a .env file has a non-local DATABASE_URL, before booting anything (I8)", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-preflight-"));
    const scenarioPath = path.join(projectDir, "scenario.yaml");
    await writeFile(scenarioPath, trivialScenarioYaml, "utf8");
    await writeFile(path.join(projectDir, ".env"), "DATABASE_URL=postgres://user:pass@db.supabase.co:5432/postgres\n", "utf8");

    const err = await runCommand({ ...baseOptions, projectDir, scenarioPath, env: {} }, logger).catch((e: unknown) => e);

    expect(TwinError.isTwinError(err)).toBe(true);
    expect((err as TwinError).code).toBe("E_UNSAFE_ENV");
    expect((err as TwinError).message).toContain("db.supabase.co");
  });

  it("rejects with E_UNSAFE_ENV for a remote DB var passed via --env too, not just .env files", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-preflight-"));
    const scenarioPath = path.join(projectDir, "scenario.yaml");
    await writeFile(scenarioPath, trivialScenarioYaml, "utf8");

    const err = await runCommand(
      { ...baseOptions, projectDir, scenarioPath, env: { MONGODB_URI: "mongodb+srv://u:p@cluster0.abc.mongodb.net/app" } },
      logger
    ).catch((e: unknown) => e);

    expect(TwinError.isTwinError(err)).toBe(true);
    expect((err as TwinError).code).toBe("E_UNSAFE_ENV");
  });

  // No package.json in projectDir for either of these, so both fail past the
  // preflight stage (a fast boot failure) - a short bootTimeoutMs means that
  // failure arrives quickly instead of waiting out 3 full retry cycles. What
  // matters is only that the failure is NOT E_UNSAFE_ENV.
  const fastFailOptions = { ...baseOptions, bootTimeoutMs: 1000 };

  it("does not refuse for a local DATABASE_URL", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-preflight-"));
    const scenarioPath = path.join(projectDir, "scenario.yaml");
    await writeFile(scenarioPath, trivialScenarioYaml, "utf8");
    await writeFile(path.join(projectDir, ".env"), "DATABASE_URL=postgres://localhost:5432/app\n", "utf8");

    const err = await runCommand({ ...fastFailOptions, projectDir, scenarioPath, env: {} }, logger).catch((e: unknown) => e);

    expect(TwinError.isTwinError(err) && err.code).not.toBe("E_UNSAFE_ENV");
  }, 20_000);

  it("--allow-remote bypasses the refusal", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-preflight-"));
    const scenarioPath = path.join(projectDir, "scenario.yaml");
    await writeFile(scenarioPath, trivialScenarioYaml, "utf8");
    await writeFile(path.join(projectDir, ".env"), "DATABASE_URL=postgres://db.supabase.co:5432/app\n", "utf8");

    const err = await runCommand(
      { ...fastFailOptions, allowRemote: true, projectDir, scenarioPath, env: {} },
      logger
    ).catch((e: unknown) => e);

    expect(TwinError.isTwinError(err) && err.code).not.toBe("E_UNSAFE_ENV");
  }, 20_000);
});

describe("runCommand twin.config.json and start-command resolution", () => {
  let projectDir: string;

  afterEach(async () => {
    if (projectDir !== undefined) await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const baseOptions: Omit<RunOptions, "projectDir" | "env"> = {
    keepWorkspaces: false,
    allowRemote: false
  };

  it("rejects with E_SCENARIO_INVALID when neither --scenario nor twin.config.json gives one", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-config-run-"));

    const err = await runCommand({ ...baseOptions, projectDir, env: {} }, logger).catch((e: unknown) => e);

    expect(TwinError.isTwinError(err)).toBe(true);
    expect((err as TwinError).code).toBe("E_SCENARIO_INVALID");
    expect((err as TwinError).message).toContain("no scenario given");
  });

  it("rejects with E_CONFIG_INVALID for a malformed twin.config.json, before touching the scenario", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-config-run-"));
    await writeFile(path.join(projectDir, "twin.config.json"), "{ not json", "utf8");

    const err = await runCommand({ ...baseOptions, projectDir, env: {} }, logger).catch((e: unknown) => e);

    expect(TwinError.isTwinError(err)).toBe(true);
    expect((err as TwinError).code).toBe("E_CONFIG_INVALID");
  });

  it("rejects with E_NO_STACK when --start is omitted and there's no package.json to detect from", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-config-run-"));
    const scenarioPath = path.join(projectDir, "scenario.yaml");
    await writeFile(scenarioPath, "name: x\nversion: 1\nsteps:\n  - id: a\n    kind: wait\n    ms: 1\n", "utf8");

    const err = await runCommand({ ...baseOptions, projectDir, scenarioPath, env: {} }, logger).catch((e: unknown) => e);

    expect(TwinError.isTwinError(err)).toBe(true);
    expect((err as TwinError).code).toBe("E_NO_STACK");
  });

  it("resolves a relative scenario path from twin.config.json against projectDir, honouring an explicit --start override", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-config-run-"));
    await writeFile(
      path.join(projectDir, "scenario.yaml"),
      "name: x\nversion: 1\nsteps:\n  - id: a\n    kind: wait\n    ms: 1\n",
      "utf8"
    );
    await writeFile(path.join(projectDir, "twin.config.json"), JSON.stringify({ scenario: "scenario.yaml" }), "utf8");

    // No package.json either, so without the config's scenario path this would fail E_SCENARIO_INVALID/E_NO_STACK instead.
    const err = await runCommand(
      { ...baseOptions, projectDir, start: 'node -e "process.exit(1)"', bootTimeoutMs: 2000, env: {} },
      logger
    ).catch((e: unknown) => e);

    expect(TwinError.isTwinError(err)).toBe(true);
    expect((err as TwinError).code).toBe("E_BOOT_CRASH"); // proves scenario+start resolution succeeded; this is just the deliberate crash
  }, 20_000);
});
