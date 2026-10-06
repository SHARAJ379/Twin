import { describe, expect, it } from "vitest";

import { computeVerdict } from "../domain/verdict.js";
import { buildReportJson } from "./reportJson.js";

describe("buildReportJson", () => {
  it("is schemaVersion 1 and carries the profile, scenario name, verdict, and findings through", () => {
    const verdict = computeVerdict([]);
    const report = buildReportJson({
      scenarioName: "basic-user-flow",
      profile: "ephemeral",
      findings: [],
      verdict,
      generatedAt: new Date("2026-01-01T00:00:00.000Z")
    });
    expect(report).toEqual({
      schemaVersion: 1,
      profile: "ephemeral",
      scenario: "basic-user-flow",
      generatedAt: "2026-01-01T00:00:00.000Z",
      verdict,
      findings: []
    });
  });
});
