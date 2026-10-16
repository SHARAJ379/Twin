import { describe, expect, it } from "vitest";

import { extractJsonPath, JsonPathError } from "./jsonPath.js";

describe("extractJsonPath", () => {
  it("reads a top-level field", () => {
    expect(extractJsonPath({ id: "abc" }, "$.id")).toBe("abc");
  });

  it("reads a nested field", () => {
    expect(extractJsonPath({ user: { email: "a@test.com" } }, "$.user.email")).toBe("a@test.com");
  });

  it("reads an array index", () => {
    expect(extractJsonPath({ items: [{ id: "x" }, { id: "y" }] }, "$.items[1].id")).toBe("y");
  });

  it("throws with the path in the message when nothing matches", () => {
    expect(() => extractJsonPath({ id: "abc" }, "$.missing")).toThrow(JsonPathError);
    expect(() => extractJsonPath({ id: "abc" }, "$.missing")).toThrow(/\$\.missing/);
  });

  it("throws when indexing into a primitive", () => {
    expect(() => extractJsonPath({ id: "abc" }, "$.id.nope")).toThrow(JsonPathError);
  });

  /**
   * `$.items[]` used to resolve to index 0: Number("") is 0 and
   * Number.isInteger(0) is true, so a typo quietly saved the first element and
   * the scenario looked like it worked.
   */
  it("rejects an empty array index instead of reading it as 0", () => {
    expect(() => extractJsonPath({ items: ["first", "second"] }, "$.items[]")).toThrow(JsonPathError);
    expect(() => extractJsonPath({ items: ["first"] }, "$.items[ ]")).toThrow(JsonPathError);
  });

  it("rejects an array index that isn't a plain integer", () => {
    for (const path of ["$.items[1.5]", "$.items[0x1]", "$.items[1e0]", "$.items[abc]"]) {
      expect(() => extractJsonPath({ items: ["first", "second"] }, path), path).toThrow(JsonPathError);
    }
  });

  it("still reads a real index", () => {
    expect(extractJsonPath({ items: ["first", "second"] }, "$.items[1]")).toBe("second");
  });
});
