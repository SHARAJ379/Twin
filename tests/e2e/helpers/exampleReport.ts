import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect } from "vitest";

interface ReportFinding {
  checkId: string;
  status: string;
  blockedBy?: string;
  suspects: { file: string; line: number; snippet: string }[];
}

interface Report {
  verdict: { passed: number; failed: number; blocked?: number; errored: number };
  findings: ReportFinding[];
}

/** The report.json of the latest run in `projectDir`. */
export async function latestReport(projectDir: string): Promise<Report> {
  const twinDir = path.join(projectDir, ".twin");
  const latest = await readFile(path.join(twinDir, "latest"), "utf8");
  return JSON.parse(await readFile(path.join(twinDir, "runs", latest, "report.json"), "utf8")) as Report;
}

/** Each finding by check id, as `fail`, `pass`, `blocked:auth`, ... */
function statusOf(report: Report): Record<string, string> {
  return Object.fromEntries(report.findings.map((f) => [f.checkId, f.blockedBy !== undefined ? `blocked:${f.blockedBy}` : f.status]));
}

/**
 * What examples/README.md promises for every `broken-<stack>`: one bug - the
 * session - and the three checks behind it blocked by its 401, not three
 * more bugs; with the tracer naming code for the session failure.
 */
export async function expectBrokenExampleReport(projectDir: string): Promise<void> {
  const report = await latestReport(projectDir);
  expect(statusOf(report)).toEqual({
    "session-survives-switch": "fail",
    "data-consistency": "blocked:auth",
    "file-consistency": "blocked:auth",
    "restart-persistence": "blocked:auth"
  });
  const session = report.findings.find((f) => f.checkId === "session-survives-switch")!;
  expect(session.suspects.length, "the tracer named no code for the session failure").toBeGreaterThan(0);
}

/** What examples/README.md promises for every `fixed-<stack>`: all four checks pass. */
export async function expectFixedExampleReport(projectDir: string): Promise<void> {
  const report = await latestReport(projectDir);
  expect(statusOf(report)).toEqual({
    "session-survives-switch": "pass",
    "data-consistency": "pass",
    "file-consistency": "pass",
    "restart-persistence": "pass"
  });
}
