import { describe, expect, it } from "vitest";

import type { Finding } from "../domain/check.js";
import { computeVerdict } from "../domain/verdict.js";
import { renderTerminalReport } from "./terminal.js";

const passFinding: Finding = {
  checkId: "session-survives-switch",
  status: "pass",
  title: "Session survives instance switch",
  summary: "Session survives instance switch: passed",
  evidence: [],
  suspects: []
};

const failFinding: Finding = {
  checkId: "data-consistency",
  status: "fail",
  title: "Data consistency",
  summary: "a record created via one instance could not be read back via another instance (status 404)",
  evidence: [],
  suspects: []
};

const errorFinding: Finding = {
  checkId: "file-consistency",
  status: "error",
  title: "File consistency",
  summary: "no control-run evidence for this step",
  evidence: [],
  suspects: [],
  reason: "the control run never produced a result for this step"
};

describe("renderTerminalReport", () => {
  it("includes the profile and a status line per finding", () => {
    const verdict = computeVerdict([passFinding]);
    const out = renderTerminalReport([passFinding], verdict, "ephemeral");
    expect(out).toContain("profile: ephemeral");
    expect(out).toContain("session-survives-switch");
  });

  it("includes a fix prompt only for fail findings", () => {
    const verdict = computeVerdict([failFinding]);
    const out = renderTerminalReport([failFinding], verdict, "ephemeral");
    expect(out).toContain("Fix prompt (paste into Claude Code):");
    expect(out).toContain("data-consistency");
  });

  it("includes the reason line for error/skipped findings, with no fix prompt", () => {
    const verdict = computeVerdict([errorFinding]);
    const out = renderTerminalReport([errorFinding], verdict, "ephemeral");
    expect(out).toContain("reason: the control run never produced a result for this step");
    expect(out).not.toContain("Fix prompt");
  });

  it("ends with a verdict line reflecting safety", () => {
    const safe = renderTerminalReport([passFinding], computeVerdict([passFinding]), "ephemeral");
    expect(safe).toContain("looks safe to run on more than one instance");

    const unsafe = renderTerminalReport([failFinding], computeVerdict([failFinding]), "ephemeral");
    expect(unsafe).toContain("NOT safe to run on more than one instance");
  });
});
