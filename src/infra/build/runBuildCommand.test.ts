import { describe, expect, it } from "vitest";

import { TwinError } from "../../domain/errors.js";
import { runBuildCommand } from "./runBuildCommand.js";

/** Prints a lot first, then the line that says what went wrong, then fails. */
const LOUD_FAILURE = `node -e "process.stderr.write('x'.repeat(400000) + '\\n'); console.error('src/app.ts(3,1): error TS2304'); process.exit(2)"`;

describe("runBuildCommand", () => {
  it("resolves when the build exits 0", async () => {
    await expect(runBuildCommand('node -e "0"', { cwd: process.cwd(), target: "the project" })).resolves.toBeUndefined();
  });

  // The logTail is the whole diagnosis Twin prints for a failed build, and a
  // compiler prints its error last - after any amount of other output.
  it("keeps the build's last line in the logTail, however much it printed first", async () => {
    const err = await runBuildCommand(LOUD_FAILURE, { cwd: process.cwd(), target: "instance A" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TwinError);
    expect((err as TwinError).code).toBe("E_BUILD_FAILED");
    expect((err as TwinError).message).toContain("instance A");
    expect(((err as TwinError).details?.logTail as string[]).join("\n")).toContain("error TS2304");
  }, 30_000);
});
