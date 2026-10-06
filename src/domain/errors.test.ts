import { describe, expect, it } from "vitest";

import { TwinError } from "./errors.js";

describe("TwinError", () => {
  it("defaults to exit code 2", () => {
    const err = new TwinError("E_INTERNAL", "something broke");
    expect(err.exitCode).toBe(2);
    expect(err.code).toBe("E_INTERNAL");
    expect(err.hint).toBeUndefined();
  });

  it("carries hint and details through", () => {
    const err = new TwinError("E_LOCKED", "already running", {
      hint: "run `twin clean`",
      details: { pid: 123 },
      exitCode: 2
    });
    expect(err.hint).toBe("run `twin clean`");
    expect(err.details).toEqual({ pid: 123 });
  });

  it("isTwinError narrows unknown values", () => {
    const err = new TwinError("E_INTERNAL", "x");
    expect(TwinError.isTwinError(err)).toBe(true);
    expect(TwinError.isTwinError(new Error("plain"))).toBe(false);
    expect(TwinError.isTwinError("nope")).toBe(false);
  });
});
