import { describe, expect, it } from "vitest";

import type { Finding } from "../domain/check.js";
import { computeVerdict } from "../domain/verdict.js";
import { renderMarkdownReport } from "./markdown.js";
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

  it("counts a session bug once, and shows the checks it 401'd as blocked with no prompt of their own", () => {
    const session: Finding = { ...failFinding, checkId: "session-survives-switch", title: "Session survives instance switch" };
    const blocked: Finding = { ...failFinding, blockedBy: "auth" };
    const findings = [session, blocked];
    const out = renderTerminalReport(findings, computeVerdict(findings), "ephemeral");
    expect(out).toContain(
      "1 bug found (session-survives-switch); 1 check couldn't be tested because of it (data-consistency) - this app is NOT safe"
    );
    expect(out.match(/Fix prompt/g)).toHaveLength(1);
    expect(out).toContain("BLOCKED data-consistency");
  });

  // Found in the pre-release audit: the note said "the session bug above",
  // but a check earlier in the scenario than /me - or an instance-divergence
  // finding, which always leads - is printed *before* the session failure.
  it("doesn't say the session bug is 'above' a blocked check printed before it", () => {
    const session: Finding = { ...failFinding, checkId: "session-survives-switch", title: "Session survives instance switch" };
    const blocked: Finding = { ...failFinding, blockedBy: "auth" };
    const findings = [blocked, session];
    const out = renderTerminalReport(findings, computeVerdict(findings), "ephemeral");
    expect(out).not.toContain("above");
    expect(out).toContain("the session bug in this report is the cause");
    expect(renderMarkdownReport("s", findings, computeVerdict(findings), "ephemeral")).not.toContain("above");
  });

  // restart-persistence is refused by the *same* instance after its restart,
  // which its summary says - the note under it used to say "on another instance".
  it("doesn't say a blocked restart-persistence was refused on another instance", () => {
    const session: Finding = {
      ...failFinding,
      checkId: "session-survives-switch",
      title: "Session survives instance switch",
      summary: "logged in, then rejected (status 401)"
    };
    const restart: Finding = {
      ...failFinding,
      checkId: "restart-persistence",
      summary: "the read-back after the restart was refused by that same instance after it restarted",
      blockedBy: "auth"
    };
    const findings = [session, restart];
    expect(renderTerminalReport(findings, computeVerdict(findings), "ephemeral")).not.toContain("another instance");
    expect(renderMarkdownReport("s", findings, computeVerdict(findings), "ephemeral")).not.toContain("another instance");
  });

  it("still gives one fix prompt when every failure is blocked - the 401 is the bug", () => {
    const blocked: Finding = { ...failFinding, blockedBy: "auth" };
    const other: Finding = { ...failFinding, checkId: "file-consistency", blockedBy: "auth" };
    const out = renderTerminalReport([blocked, other], computeVerdict([blocked, other]), "ephemeral");
    expect(out.match(/Fix prompt/g)).toHaveLength(1);
    expect(out).toContain("1 bug found (authenticated requests were rejected on another instance)");
  });
});

describe("renderTerminalReport: a failure with no suspect", () => {
  it("says there is no confident suspect rather than leaving it blank", () => {
    const f: Finding = {
      checkId: "session-survives-switch",
      status: "fail",
      title: "Session survives instance switch",
      summary: "rejected (status 401)",
      evidence: [],
      suspects: []
    };
    expect(renderTerminalReport([f], computeVerdict([f]), "ephemeral")).toContain("likely cause: no confident suspect");
  });
});
