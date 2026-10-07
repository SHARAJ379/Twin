import { describe, expect, it } from "vitest";

import { validateTwinConfig } from "./twinConfig.js";

describe("validateTwinConfig", () => {
  it("accepts an empty object", () => {
    expect(validateTwinConfig({})).toEqual({ ok: true, config: {} });
  });

  it("accepts every known field with the right type", () => {
    const data = {
      scenario: "scenario.yaml",
      start: "npm start",
      build: "npm run build",
      healthPath: "/health",
      portEnv: "PORT",
      bootTimeoutMs: 30_000,
      env: { FOO: "bar" },
      allowRemote: false
    };
    expect(validateTwinConfig(data)).toEqual({ ok: true, config: data });
  });

  it("rejects a non-object", () => {
    const result = validateTwinConfig("scenario.yaml");
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown property", () => {
    const result = validateTwinConfig({ scenario: "x", typo: true });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors).toEqual([{ message: 'unknown property "typo"', path: "/typo" }]);
  });

  it("rejects a string field with the wrong type", () => {
    const result = validateTwinConfig({ start: 123 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors[0]?.path).toBe("/start");
  });

  it("rejects bootTimeoutMs that isn't a number", () => {
    const result = validateTwinConfig({ bootTimeoutMs: "30000" });
    expect(result.ok).toBe(false);
  });

  it("rejects env with a non-string value", () => {
    const result = validateTwinConfig({ env: { FOO: 1 } });
    expect(result.ok).toBe(false);
  });

  it("rejects allowRemote that isn't a boolean", () => {
    const result = validateTwinConfig({ allowRemote: "yes" });
    expect(result.ok).toBe(false);
  });
});
