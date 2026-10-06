import { describe, expect, it } from "vitest";

import { stepsWithoutRestarts } from "./scenarioTransform.js";
import type { Scenario } from "./scenario.js";

describe("stepsWithoutRestarts", () => {
  it("drops restart steps and keeps everything else, in order", () => {
    const scenario: Scenario = {
      version: 1,
      name: "s",
      steps: [
        { kind: "request", id: "a", request: { method: "GET", path: "/" } },
        { kind: "restart", id: "r", instance: "A" },
        { kind: "wait", id: "w", ms: 10 }
      ]
    };
    const result = stepsWithoutRestarts(scenario);
    expect(result.steps.map((s) => s.id)).toEqual(["a", "w"]);
    expect(scenario.steps).toHaveLength(3); // original untouched
  });
});
