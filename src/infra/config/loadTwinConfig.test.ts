import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TwinError } from "../../domain/errors.js";
import { loadTwinConfig } from "./loadTwinConfig.js";

describe("loadTwinConfig", () => {
  let projectDir: string;

  afterEach(async () => {
    if (projectDir !== undefined) await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("returns undefined when there is no twin.config.json", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-config-"));
    await expect(loadTwinConfig(projectDir)).resolves.toBeUndefined();
  });

  it("parses a valid config", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-config-"));
    await writeFile(path.join(projectDir, "twin.config.json"), JSON.stringify({ scenario: "scenario.yaml", start: "npm start" }), "utf8");

    await expect(loadTwinConfig(projectDir)).resolves.toEqual({ scenario: "scenario.yaml", start: "npm start" });
  });

  it("throws E_CONFIG_INVALID for malformed JSON", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-config-"));
    await writeFile(path.join(projectDir, "twin.config.json"), "{ not json", "utf8");

    const err = await loadTwinConfig(projectDir).catch((e: unknown) => e);
    expect(TwinError.isTwinError(err)).toBe(true);
    expect((err as TwinError).code).toBe("E_CONFIG_INVALID");
  });

  it("throws E_CONFIG_INVALID for a config with the wrong shape", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-config-"));
    await writeFile(path.join(projectDir, "twin.config.json"), JSON.stringify({ bootTimeoutMs: "fast" }), "utf8");

    const err = await loadTwinConfig(projectDir).catch((e: unknown) => e);
    expect(TwinError.isTwinError(err)).toBe(true);
    expect((err as TwinError).code).toBe("E_CONFIG_INVALID");
  });
});
