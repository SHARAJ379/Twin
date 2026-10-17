import { describe, expect, it } from "vitest";

import type { Finding } from "../domain/check.js";
import { computeVerdict } from "../domain/verdict.js";
import { buildFixPrompt } from "./fixPrompt.js";
import { renderTerminalReport } from "./terminal.js";

const finding = (summary: string, suspects: Finding["suspects"] = []): Finding => ({
  checkId: "session-survives-switch",
  status: "fail",
  title: "Session survives instance switch",
  summary,
  evidence: [],
  suspects
});

/** Audit, third round: "...(status 401) Fix the underlying issue..." - the summary ran into the next sentence. */
describe("buildFixPrompt", () => {
  it.each([[[]], [[{ file: "server.js", line: 19, snippet: "const sessions = {};", kind: "in-memory-session", confidence: "medium" }]]])(
    "ends the summary with a full stop before the next sentence (suspects: %j)",
    (suspects) => {
      const prompt = buildFixPrompt(finding("rejected (status 401)", suspects as Finding["suspects"]), "ephemeral");
      expect(prompt).toContain("rejected (status 401). ");
      expect(prompt).not.toMatch(/\) (Fix|I don't)/);
    }
  );

  it("doesn't double a summary's own punctuation", () => {
    expect(buildFixPrompt(finding("it was missing."), "ephemeral")).toContain("it was missing. ");
    expect(buildFixPrompt(finding("it was missing."), "ephemeral")).not.toContain("..");
  });
});

describe("the terminal's fix prompt", () => {
  it("is an indented block with no wrapping quotes, so it copies cleanly", () => {
    const f = finding("rejected (status 401)");
    const out = renderTerminalReport([f], computeVerdict([f]), "ephemeral").split("\n");
    const at = out.indexOf("  Fix prompt (paste into Claude Code):");
    const prompt = out[at + 1]!;
    expect(prompt).toBe(`    ${buildFixPrompt(f, "ephemeral")}`);
    expect(prompt.trimStart().startsWith('"')).toBe(false);
    expect(prompt.endsWith('"')).toBe(false);
  });
});
