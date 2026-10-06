import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scenarioSchema } from "./scenarioSchema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publishedPath = path.resolve(here, "../../docs/scenario.schema.json");

describe("docs/scenario.schema.json", () => {
  it("is kept in sync with domain/scenarioSchema.ts (the source of truth)", async () => {
    const published: unknown = JSON.parse(await readFile(publishedPath, "utf8"));
    expect(published).toEqual(scenarioSchema);
  });
});
