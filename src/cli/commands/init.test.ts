import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConsoleLogger } from "../../infra/log/consoleLogger.js";
import { initCommand } from "./init.js";

const logger = new ConsoleLogger({ level: "error" });

describe("initCommand", () => {
  let projectDir: string;

  afterEach(async () => {
    if (projectDir !== undefined) await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("writes a valid scenario.yaml and a twin.config.json pointing at it", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-init-"));
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ scripts: { start: "node server.js" } }), "utf8");

    await initCommand({ projectDir, scenarioPath: "scenario.yaml", force: false }, logger);

    const scenario = await readFile(path.join(projectDir, "scenario.yaml"), "utf8");
    expect(scenario).toContain("kind: request");

    const config = JSON.parse(await readFile(path.join(projectDir, "twin.config.json"), "utf8")) as { scenario: string; start: string };
    expect(config.scenario).toBe("scenario.yaml");
    expect(config.start).toBe("npm start");
  });

  it("omits \"start\" from the config when it can't be detected, without failing", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-init-")); // no package.json

    await initCommand({ projectDir, scenarioPath: "scenario.yaml", force: false }, logger);

    const config = JSON.parse(await readFile(path.join(projectDir, "twin.config.json"), "utf8")) as Record<string, unknown>;
    expect(config.scenario).toBe("scenario.yaml");
    expect(config.start).toBeUndefined();
  });

  it("does not overwrite an existing scenario.yaml or twin.config.json without --force", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-init-"));
    await writeFile(path.join(projectDir, "scenario.yaml"), "name: mine\nversion: 1\nsteps: []\n", "utf8");
    await writeFile(path.join(projectDir, "twin.config.json"), JSON.stringify({ scenario: "mine.yaml" }), "utf8");

    await initCommand({ projectDir, scenarioPath: "scenario.yaml", force: false }, logger);

    expect(await readFile(path.join(projectDir, "scenario.yaml"), "utf8")).toContain("name: mine");
    expect(JSON.parse(await readFile(path.join(projectDir, "twin.config.json"), "utf8"))).toEqual({ scenario: "mine.yaml" });
  });

  it("overwrites both files with --force", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-init-"));
    await writeFile(path.join(projectDir, "scenario.yaml"), "name: mine\nversion: 1\nsteps: []\n", "utf8");
    await writeFile(path.join(projectDir, "twin.config.json"), JSON.stringify({ scenario: "mine.yaml" }), "utf8");

    await initCommand({ projectDir, scenarioPath: "scenario.yaml", force: true }, logger);

    expect(await readFile(path.join(projectDir, "scenario.yaml"), "utf8")).toContain("name: starter");
  });
});
