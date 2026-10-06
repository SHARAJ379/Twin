import { describe, expect, it } from "vitest";

import { staticRules } from "./staticRules.js";

/**
 * §7.6 point 3: "Rules without both fixtures can't be merged." This is the
 * enforcement of that rule - a new rule added to staticRules.ts with a
 * missing or wrong fixture fails CI, not just a code-review nit.
 */
describe.each(staticRules)("static rule: $id", (rule) => {
  it("has at least one `matches` and one `nonMatches` fixture", () => {
    expect(rule.fixtures.matches.length).toBeGreaterThan(0);
    expect(rule.fixtures.nonMatches.length).toBeGreaterThan(0);
  });

  it("actually matches every `matches` fixture", () => {
    for (const fixture of rule.fixtures.matches) {
      const matched = fixture.split("\n").some((line) => rule.test(line, fixture));
      expect(matched, `expected rule "${rule.id}" to match fixture:\n${fixture}`).toBe(true);
    }
  });

  it("does not match any `nonMatches` fixture", () => {
    for (const fixture of rule.fixtures.nonMatches) {
      const matched = fixture.split("\n").some((line) => rule.test(line, fixture));
      expect(matched, `expected rule "${rule.id}" NOT to match fixture:\n${fixture}`).toBe(false);
    }
  });
});
