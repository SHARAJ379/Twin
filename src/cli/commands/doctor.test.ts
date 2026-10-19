import { afterEach, describe, expect, it } from "vitest";

import type { Logger } from "../../ports/logger.js";
import { printDoctorReport, runDoctorChecks } from "./doctor.js";

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silent };

describe("twin doctor", () => {
  const savedPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = savedPath;
  });

  it("passes on this machine", () => {
    expect(printDoctorReport(runDoctorChecks(), silent)).toBe(true);
  });

  // Found in the pre-release audit: nothing in Twin runs git, yet a machine
  // without it failed doctor (exit 1), told it was "only needed for
  // `twin init` on a fresh repo" - which doesn't use git either.
  it("still passes without git, saying it's only needed to install from source", () => {
    process.env.PATH = "";

    const checks = runDoctorChecks();
    const git = checks.find((check) => check.name.startsWith("git"))!;

    expect(git.ok).toBe(true);
    expect(git.detail).toContain("install Twin from source");
    expect(printDoctorReport(checks, silent)).toBe(true);
  });
});
