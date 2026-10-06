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
});
