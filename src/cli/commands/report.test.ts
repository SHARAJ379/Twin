import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Finding } from "../../domain/check.js";
import { TwinError } from "../../domain/errors.js";
import { computeVerdict } from "../../domain/verdict.js";
import { FsArtifactStore } from "../../infra/artifacts/fsArtifactStore.js";
import { renderMarkdownReport } from "../../report/markdown.js";
import { buildReportJson } from "../../report/reportJson.js";
import { reportCommand } from "./report.js";

const passFinding: Finding = {
  checkId: "data-consistency",
  status: "pass",
  title: "Data consistency",
  summary: "a record created via one instance was read back via another instance",
  evidence: [],
  suspects: []
};

const failFinding: Finding = {
  checkId: "file-consistency",
  status: "fail",
  title: "File consistency",
  summary: "a file uploaded via one instance could not be fetched via another instance (status 404)",
  evidence: [],
  suspects: []
};

async function seedRun(projectDir: string, findings: Finding[], runId?: string): Promise<string> {
  const store = new FsArtifactStore(projectDir);
  // Explicit ids (vs. store.createRun()'s time-based one) keep tests that seed
  // more than one run in the same process deterministic, not second-boundary-dependent.
  const run = runId === undefined ? await store.createRun() : store.getRun(runId);
  if (runId !== undefined) await mkdir(run.dir, { recursive: true });
  const verdict = computeVerdict(findings);
  const reportJson = buildReportJson({ scenarioName: "basic-user-flow", profile: "ephemeral", findings, verdict });

  await writeFile(store.pathFor(run, "report.json"), JSON.stringify(reportJson, null, 2), "utf8");
  await writeFile(
    store.pathFor(run, "report.md"),
    renderMarkdownReport("basic-user-flow", findings, verdict, "ephemeral"),
    "utf8"
  );
  await store.writeLatestPointer(run);
  return run.id;
}

describe("reportCommand", () => {
  let projectDir: string;

  afterEach(async () => {
    if (projectDir !== undefined) await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("rejects with E_NO_REPORT when no run has ever completed in this project", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-report-"));

    const err = await reportCommand({ projectDir, format: "terminal" }, () => {}).catch((e: unknown) => e);

    expect(TwinError.isTwinError(err)).toBe(true);
    expect((err as TwinError).code).toBe("E_NO_REPORT");
  });

  it("rejects with E_NO_REPORT for a --run id that doesn't exist", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-report-"));
    await seedRun(projectDir, [passFinding]);

    const err = await reportCommand({ projectDir, run: "nonexistent-run", format: "terminal" }, () => {}).catch(
      (e: unknown) => e
    );

    expect(TwinError.isTwinError(err)).toBe(true);
    expect((err as TwinError).code).toBe("E_NO_REPORT");
  });

  it("re-prints the latest run's terminal report and returns exit code 0 when everything passed", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-report-"));
    await seedRun(projectDir, [passFinding]);

    let printed = "";
    const exitCode = await reportCommand({ projectDir, format: "terminal" }, (text) => (printed = text));

    expect(exitCode).toBe(0);
    expect(printed).toContain("data-consistency");
    expect(printed).toContain("safe to run on more than one instance");
  });

  it("returns exit code 1 and the fix prompt when the latest run has a failing check", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-report-"));
    await seedRun(projectDir, [failFinding]);

    let printed = "";
    const exitCode = await reportCommand({ projectDir, format: "terminal" }, (text) => (printed = text));

    expect(exitCode).toBe(1);
    expect(printed).toContain("Fix prompt");
  });

  it("prints the raw ReportJson for --format json", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-report-"));
    await seedRun(projectDir, [passFinding]);

    let printed = "";
    await reportCommand({ projectDir, format: "json" }, (text) => (printed = text));

    const parsed = JSON.parse(printed) as { schemaVersion: number; scenario: string };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.scenario).toBe("basic-user-flow");
  });

  it("prints the saved markdown report for --format markdown", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-report-"));
    await seedRun(projectDir, [passFinding]);

    let printed = "";
    await reportCommand({ projectDir, format: "markdown" }, (text) => (printed = text));

    expect(printed).toContain("# Twin report: basic-user-flow");
  });

  it("can report on an older run by id, not just the latest", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-report-"));
    const firstRunId = await seedRun(projectDir, [passFinding], "run-1");
    await seedRun(projectDir, [failFinding], "run-2"); // becomes "latest"

    let printed = "";
    const exitCode = await reportCommand({ projectDir, run: firstRunId, format: "terminal" }, (text) => (printed = text));

    expect(exitCode).toBe(0);
    expect(printed).toContain("data-consistency");
  });
});
