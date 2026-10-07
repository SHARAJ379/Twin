import { describe, expect, it } from "vitest";

import type { SuspectRule } from "../domain/suspectRule.js";
import { stackProfiles } from "../domain/stacks/index.js";

/**
 * Every rule, for every stack, carries its own proof. This is the only
 * enforcement of that rule - a new rule added to a stack profile with a
 * regex that doesn't actually fire (or fires on everything) fails here.
 *
 * It's also the main quality gate for stacks whose runtime isn't installed
 * on this machine: the patterns are validated even when no real Go/Ruby/PHP
 * app can be booted. §7.6 point 3: "Rules without both fixtures can't be merged."
 */
const allRules: { stackId: string; rule: SuspectRule }[] = stackProfiles.flatMap((profile) =>
  profile.rules.map((rule) => ({ stackId: profile.id, rule }))
);

describe.each(allRules)("static rule: $stackId / $rule.id", ({ rule }) => {
  it("declares both kinds of fixture", () => {
    expect(rule.fixtures.matches.length).toBeGreaterThan(0);
    expect(rule.fixtures.nonMatches.length).toBeGreaterThan(0);
  });

  it("fires on every `matches` fixture", () => {
    for (const fixture of rule.fixtures.matches) {
      const fired = fixture.split("\n").some((line) => rule.test(line, fixture));
      expect(fired, `expected rule ${rule.id} to match:\n${fixture}`).toBe(true);
    }
  });

  it("fires on none of the `nonMatches` fixtures", () => {
    for (const fixture of rule.fixtures.nonMatches) {
      const fired = fixture.split("\n").some((line) => rule.test(line, fixture));
      expect(fired, `expected rule ${rule.id} NOT to match:\n${fixture}`).toBe(false);
    }
  });
});

describe("stack profiles", () => {
  it("gives every rule a globally unique id", () => {
    const ids = allRules.map(({ rule }) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every stack at least one rule, one marker and one source extension", () => {
    for (const profile of stackProfiles) {
      expect(profile.rules.length, `${profile.id} has no rules`).toBeGreaterThan(0);
      expect(profile.markers.length, `${profile.id} has no markers`).toBeGreaterThan(0);
      expect(profile.sourceExtensions.length, `${profile.id} has no source extensions`).toBeGreaterThan(0);
    }
  });

  it("gives every stack a unique id", () => {
    const ids = stackProfiles.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
