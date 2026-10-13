import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runCommand, type RunOptions } from "../../src/cli/commands/run.js";
import { ConsoleLogger } from "../../src/infra/log/consoleLogger.js";
import { fixtureDepsMissing } from "./helpers/fixtureRequirements.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const brokenExpressDir = path.resolve(here, "../../examples/broken-express");
const fixedExpressDir = path.resolve(here, "../../examples/fixed-express");

const logger = new ConsoleLogger({ level: "error" }); // keep test output focused on assertion failures

const baseOptions: Omit<RunOptions, "projectDir" | "scenarioPath" | "env"> = {
  start: "npm start",
  healthPath: "/health",
  portEnv: "PORT",
  bootTimeoutMs: 30_000,
  keepWorkspaces: false,
  allowRemote: false
};

/**
 * Milestone 4 acceptance test (TWIN_ARCHITECTURE.md §16.4): `twin run`
 * end-to-end against the two example apps and a deliberately typo'd
 * scenario - exactly "broken => FAIL, fixed => PASS, typo scenario => ERROR".
 */
describe.skipIf(fixtureDepsMissing(brokenExpressDir, fixedExpressDir))(
  "twin run: broken => FAIL, fixed => PASS, typo scenario => ERROR",
  () => {
  const twinDirsToClean: string[] = [];

  afterEach(async () => {
    for (const dir of twinDirsToClean.splice(0)) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("FAILs all four checks against examples/broken-express, with the tracer attaching real suspects", async () => {
    const twinDir = path.join(brokenExpressDir, ".twin");
    twinDirsToClean.push(twinDir);
    const exitCode = await runCommand(
      {
        ...baseOptions,
        projectDir: brokenExpressDir,
        scenarioPath: path.join(brokenExpressDir, "scenario.yaml"),
        env: {},
        // Express always sends this header, and it is not on the evidence
        // allowlist - so it is the cheapest end-to-end proof that
        // --redact-header reaches the scenario client at all (it used to be a
        // RunContext field nothing ever populated).
        redactHeaders: ["x-powered-by"]
      },
      logger
    );
    expect(exitCode).toBe(1);

    const latestId = await readFile(path.join(twinDir, "latest"), "utf8");
    const report = JSON.parse(await readFile(path.join(twinDir, "runs", latestId, "report.json"), "utf8")) as {
      verdict: { failed: number };
      findings: { checkId: string; status: string; suspects: unknown[]; evidence: { run: "control" | "split"; stepId: string }[] }[];
    };
    expect(report.verdict.failed).toBe(4);
    // At least the two file-backed checks (file-consistency, restart-persistence)
    // must get real tracer evidence, not just an empty suspects list.
    expect(report.findings.every((f) => f.status === "fail")).toBe(true);
    expect(report.findings.some((f) => f.suspects.length > 0)).toBe(true);

    // Every finding's evidence is a pointer ({run, stepId}); results.json is
    // what those pointers point at. Without it on disk, a report referenced
    // evidence nobody could open.
    const ledger = JSON.parse(await readFile(path.join(twinDir, "runs", latestId, "results.json"), "utf8")) as {
      schemaVersion: number;
      control: { stepId: string; response?: { headers: Record<string, string> } }[];
      split: { stepId: string }[];
    };
    expect(ledger.schemaVersion).toBe(1);
    expect(ledger.control.length).toBeGreaterThan(0);
    expect(ledger.split.length).toBeGreaterThan(0);
    for (const finding of report.findings) {
      for (const ref of finding.evidence) {
        expect(ledger[ref.run].some((result) => result.stepId === ref.stepId)).toBe(true);
      }
    }

    const headersSeen = ledger.control.flatMap((result) => Object.entries(result.response?.headers ?? {}));
    expect(headersSeen.some(([name]) => name === "x-powered-by")).toBe(true);
    expect(headersSeen.filter(([name]) => name === "x-powered-by").every(([, value]) => value === "<redacted>")).toBe(true);
  }, 150_000);

  it("PASSes all four checks against examples/fixed-express, given shared session secret/data/upload paths", async () => {
    twinDirsToClean.push(path.join(fixedExpressDir, ".twin"));
    const sharedDir = await mkdtemp(path.join(os.tmpdir(), "twin-fixed-shared-"));
    const exitCode = await runCommand(
      {
        ...baseOptions,
        projectDir: fixedExpressDir,
        scenarioPath: path.join(fixedExpressDir, "scenario.yaml"),
        env: {
          SESSION_SECRET: "test-secret-123",
          DATA_FILE: path.join(sharedDir, "data.json"),
          UPLOAD_DIR: path.join(sharedDir, "uploads")
        }
      },
      logger
    );
    expect(exitCode).toBe(0);
  }, 150_000);

  it("ERRORs (never FAILs) on a scenario typo - the control run fails on its own, so I7 blocks a FAIL verdict", async () => {
    twinDirsToClean.push(path.join(brokenExpressDir, ".twin"));
    const exitCode = await runCommand(
      { ...baseOptions, projectDir: brokenExpressDir, scenarioPath: path.join(brokenExpressDir, "scenario-typo.yaml"), env: {} },
      logger
    );
    expect(exitCode).toBe(2);
  }, 150_000);
});
