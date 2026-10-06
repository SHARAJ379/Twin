import { describe, expect, it } from "vitest";

import type { Finding } from "../domain/check.js";
import { computeVerdict } from "../domain/verdict.js";
import { renderMarkdownReport } from "./markdown.js";

const failFinding: Finding = {
  checkId: "data-consistency",
  status: "fail",
  title: "Data consistency",
  summary: "a record created via one instance could not be read back via another instance (status 404)",
  evidence: [],
  suspects: []
};

describe("renderMarkdownReport", () => {
  it("renders a heading, verdict summary, and a fenced fix-prompt code block", () => {
    const verdict = computeVerdict([failFinding]);
    const out = renderMarkdownReport("basic-user-flow", [failFinding], verdict, "ephemeral");

    expect(out).toContain("# Twin report: basic-user-flow");
    expect(out).toContain("Profile: `ephemeral`");
    expect(out).toContain("NOT safe to run on more than one instance");
    expect(out).toContain("## FAIL — data-consistency");
    expect(out).toContain("```");
    expect(out).toContain("re-run `twin run`");
  });
});
