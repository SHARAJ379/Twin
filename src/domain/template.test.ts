import { describe, expect, it } from "vitest";

import { renderTemplate, renderTemplateDeep, TemplateVariableError } from "./template.js";

const helpers = { unique: () => "U1", uuid: () => "uuid-1", now: () => "2026-01-01T00:00:00Z" };

describe("renderTemplate", () => {
  it("substitutes a known variable", () => {
    expect(renderTemplate("id is {{itemId}}", { itemId: "42" }, helpers)).toBe("id is 42");
  });

  it("substitutes {{unique}}, {{uuid}}, {{now}} via the injected helpers", () => {
    expect(renderTemplate("{{unique}}-{{uuid}}-{{now}}", {}, helpers)).toBe("U1-uuid-1-2026-01-01T00:00:00Z");
  });

  it("throws TemplateVariableError naming the missing variable", () => {
    expect(() => renderTemplate("{{missing}}", {}, helpers)).toThrow(TemplateVariableError);
    expect(() => renderTemplate("{{missing}}", {}, helpers)).toThrow(/missing/);
  });

  it("leaves text with no template markers untouched", () => {
    expect(renderTemplate("plain text", {}, helpers)).toBe("plain text");
  });
});

describe("renderTemplateDeep", () => {
  it("renders string leaves inside nested objects and arrays", () => {
    const input = { name: "{{unique}}-item", tags: ["{{uuid}}", "static"], count: 3, nested: { id: "{{itemId}}" } };
    const out = renderTemplateDeep(input, { itemId: "7" }, helpers);
    expect(out).toEqual({ name: "U1-item", tags: ["uuid-1", "static"], count: 3, nested: { id: "7" } });
  });
});
