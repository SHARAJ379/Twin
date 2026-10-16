import { describe, expect, it } from "vitest";

import type { SuspectRule } from "../domain/suspectRule.js";
import { stackProfiles } from "../domain/stacks/index.js";
import { splitLines } from "./sourceLines.js";

/**
 * The fixtures are written here as LF strings, but on Windows git hands the
 * tracer the same code as CRLF (`core.autocrlf`), and that used to defeat
 * every `$`-anchored rule on any line carrying a trailing comment - see
 * sourceLines.ts. So each fixture is proved twice, once per line ending: the
 * rules have to behave identically on a Windows checkout.
 *
 * Each line is *terminated*, not just joined: a fixture is usually a single
 * line, so inserting separators between lines would leave it with no line
 * ending at all and quietly prove nothing.
 */
const LINE_ENDINGS = [
  { name: "LF", ending: "\n" },
  { name: "CRLF", ending: "\r\n" }
] as const;

/** The fixture as a file with this line ending - every line terminated, as a real file's are. */
function asFile(fixture: string, ending: string): string {
  return fixture
    .split("\n")
    .map((line) => line + ending)
    .join("");
}

/** What the tracer itself does to a file before a rule ever sees a line. */
function rulesFire(rule: SuspectRule, fixture: string): boolean {
  return splitLines(fixture).some((line) => rule.test(line, fixture));
}

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

  it.each(LINE_ENDINGS)("fires on every `matches` fixture ($name)", ({ ending }) => {
    for (const fixture of rule.fixtures.matches) {
      expect(rulesFire(rule, asFile(fixture, ending)), `expected rule ${rule.id} to match:\n${fixture}`).toBe(true);
    }
  });

  it.each(LINE_ENDINGS)("fires on none of the `nonMatches` fixtures ($name)", ({ ending }) => {
    for (const fixture of rule.fixtures.nonMatches) {
      expect(rulesFire(rule, asFile(fixture, ending)), `expected rule ${rule.id} NOT to match:\n${fixture}`).toBe(false);
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
