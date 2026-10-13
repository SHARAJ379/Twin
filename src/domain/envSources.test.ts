import { describe, expect, it } from "vitest";

import { mergeEnvSources } from "./envSources.js";

describe("mergeEnvSources", () => {
  it("lets later sources win, matching twin run's documented precedence", () => {
    const { env } = mergeEnvSources([
      { name: ".env", vars: { DATABASE_URL: "from-dotenv", KEEP: "kept" } },
      { name: "shell", vars: { DATABASE_URL: "from-shell" } },
      { name: "--env", vars: { DATABASE_URL: "from-flag" } }
    ]);

    expect(env.DATABASE_URL).toBe("from-flag");
    expect(env.KEEP).toBe("kept");
  });

  it("names the source that actually set the value, not the first one to mention it", () => {
    const { originOf } = mergeEnvSources([
      { name: ".env", vars: { DATABASE_URL: "from-dotenv" } },
      { name: "--env", vars: { DATABASE_URL: "from-flag" } }
    ]);

    // The whole point: ".env" is the natural guess and it would be wrong here.
    expect(originOf("DATABASE_URL")).toBe("--env");
  });

  it("skips undefined values, which is how process.env reports an unset key", () => {
    const { env, originOf } = mergeEnvSources([
      { name: ".env", vars: { DATABASE_URL: "from-dotenv" } },
      { name: "shell", vars: { DATABASE_URL: undefined } }
    ]);

    expect(env.DATABASE_URL).toBe("from-dotenv");
    expect(originOf("DATABASE_URL")).toBe(".env");
  });

  it("falls back to a generic origin for a key nothing set", () => {
    expect(mergeEnvSources([]).originOf("NOPE")).toBe("the environment");
  });
});
