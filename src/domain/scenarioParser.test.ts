import { describe, expect, it } from "vitest";

import { parseScenarioYaml } from "./scenarioParser.js";

const validYaml = `
name: basic-user-flow
version: 1
steps:
  - id: signup
    kind: request
    request: { method: POST, path: /signup, json: { email: "a@test.com", password: "pw12345" } }
    expect: { status: [200, 201] }
  - id: login
    kind: request
    via: A
    request: { method: POST, path: /login, json: { email: "a@test.com", password: "pw12345" } }
    expect: { status: 200 }
  - id: create-item
    kind: request
    via: A
    request: { method: POST, path: /items, json: { name: "test" } }
    save: { itemId: "$.id" }
  - id: read-item-other-instance
    kind: request
    via: B
    request: { method: GET, path: "/items/{{itemId}}" }
    expect: { status: 200, bodyContains: "test" }
    check: data-consistency
  - id: restart-a
    kind: restart
    instance: A
  - id: read-after-restart
    kind: request
    via: A
    request: { method: GET, path: "/items/{{itemId}}" }
    expect: { status: 200 }
    check: restart-persistence
`;

describe("parseScenarioYaml", () => {
  it("parses the full example scenario from TWIN_CONTEXT.md", () => {
    const result = parseScenarioYaml(validYaml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scenario.name).toBe("basic-user-flow");
      expect(result.scenario.steps).toHaveLength(6);
      expect(result.scenario.steps[4]).toMatchObject({ kind: "restart", instance: "A" });
    }
  });

  it("reports a YAML syntax error with a line number", () => {
    const result = parseScenarioYaml("name: x\nsteps:\n  - id: a\n  bad indent: [");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]!.line).toBeGreaterThan(0);
    }
  });

  it("reports a schema error for a missing required field, with a path", () => {
    const result = parseScenarioYaml(`
name: x
version: 1
steps:
  - id: a
    kind: request
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path.includes("/steps/0"))).toBe(true);
    }
  });

  it("reports an unknown property", () => {
    const result = parseScenarioYaml(`
name: x
version: 1
steps:
  - id: a
    kind: wait
    ms: 10
    bogus: true
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("bogus"))).toBe(true);
    }
  });

  it("rejects an unknown version", () => {
    const result = parseScenarioYaml(`
name: x
version: 2
steps:
  - id: a
    kind: wait
    ms: 10
`);
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate step ids", () => {
    const result = parseScenarioYaml(`
name: x
version: 1
steps:
  - id: a
    kind: wait
    ms: 10
  - id: a
    kind: wait
    ms: 20
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("duplicate step id"))).toBe(true);
    }
  });

  it("rejects via pointing at an unknown instance", () => {
    const result = parseScenarioYaml(`
name: x
version: 1
steps:
  - id: a
    kind: request
    via: C
    request: { method: GET, path: / }
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes('"via: C"'))).toBe(true);
    }
  });

  it("rejects an after reference to a step that hasn't run yet", () => {
    const result = parseScenarioYaml(`
name: x
version: 1
steps:
  - id: a
    kind: request
    after: [b]
    request: { method: GET, path: / }
  - id: b
    kind: request
    request: { method: GET, path: / }
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes('"after: b"'))).toBe(true);
    }
  });

  it("rejects a restart step targeting an unknown instance", () => {
    const result = parseScenarioYaml(
      `
name: x
version: 1
steps:
  - id: a
    kind: restart
    instance: Z
`,
      { knownInstances: ["A", "B"] }
    );
    expect(result.ok).toBe(false);
  });

  it("accepts via: any", () => {
    const result = parseScenarioYaml(`
name: x
version: 1
steps:
  - id: a
    kind: request
    via: any
    request: { method: GET, path: / }
`);
    expect(result.ok).toBe(true);
  });
});

describe("parseScenarioYaml client validation", () => {
  const withClients = (clients: string | undefined, as: string): string =>
    [
      "name: s",
      "version: 1",
      ...(clients === undefined ? [] : [`clients: ${clients}`]),
      "steps:",
      "  - id: login",
      `    kind: request`,
      `    as: ${as}`,
      "    request: { method: GET, path: / }"
    ].join("\n");

  it("accepts an `as` that the scenario declares in `clients`", () => {
    const result = parseScenarioYaml(withClients("[alice, bob]", "alice"));
    expect(result.ok).toBe(true);
  });

  it('always accepts `as: default`, which is the jar a step gets anyway', () => {
    expect(parseScenarioYaml(withClients(undefined, "default")).ok).toBe(true);
  });

  it("rejects an `as` that is not in the declared `clients` - the typo that silently sent no cookies", () => {
    const result = parseScenarioYaml(withClients("[alice, bob]", "alcie"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.path).toBe("/steps/0/as");
    expect(result.errors[0]?.message).toContain('"as: alcie"');
    expect(result.errors[0]?.message).toContain("alice, bob");
    expect(result.errors[0]?.line).toBe(7);
  });

  it("rejects an `as` when the scenario declares no clients at all, and says how to declare one", () => {
    const result = parseScenarioYaml(withClients(undefined, "alice"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain('clients: ["alice"]');
  });

  it("rejects a duplicated or empty client name", () => {
    expect(parseScenarioYaml(withClients("[alice, alice]", "alice")).ok).toBe(false);
    expect(parseScenarioYaml(withClients('[""]', "default")).ok).toBe(false);
  });
});

describe("parseScenarioYaml alias expansion", () => {
  it("refuses an alias bomb instead of expanding until it runs out of memory", () => {
    // The classic shape: each level aliases the one below it nine times, so
    // the expanded document is exponential in the number of levels.
    const bomb = [
      "name: boom",
      "version: 1",
      "a: &a [x, x, x, x, x, x, x, x, x]",
      "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]",
      "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]",
      "d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c]",
      "e: &e [*d, *d, *d, *d, *d, *d, *d, *d, *d]",
      "steps: [*e]"
    ].join("\n");

    const result = parseScenarioYaml(bomb);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain("alias expansion is capped at");
  });

  it("still allows the reason anchors get used here: one request reused across every step", () => {
    const steps = Array.from({ length: 40 }, (_, i) =>
      i === 0
        ? ["  - id: step0", "    kind: request", "    request: &req { method: GET, path: /health }", "    expect: &exp { status: 200 }"].join(
            "\n"
          )
        : ["  - id: step" + String(i), "    kind: request", "    request: *req", "    expect: *exp"].join("\n")
    );

    const result = parseScenarioYaml(["name: anchored", "version: 1", "steps:", ...steps].join("\n"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scenario.steps).toHaveLength(40);
  });
});
