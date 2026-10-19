import { describe, expect, it } from "vitest";

import { TwinError } from "../../domain/errors.js";
import { runSetupCommand } from "./runSetupCommand.js";

/** Prints a lot first, then the line that says what went wrong, then fails. */
const LOUD_FAILURE = `node -e "process.stderr.write('x'.repeat(400000) + '\\n'); console.error('could not reach the database'); process.exit(3)"`;

describe("runSetupCommand", () => {
  it("resolves when the command exits 0", async () => {
    await expect(runSetupCommand('node -e "0"', { cwd: process.cwd(), env: {}, phase: "CONTROL" })).resolves.toBeUndefined();
  });

  // The logTail is the whole diagnosis Twin prints for a failed setup, and a
  // failing command prints its error last. Read on 'exit', the tail came back
  // without it on Linux CI (run 39222250425); it never did on Windows.
  it("keeps the command's last line in the logTail, however much it printed first", async () => {
    const err = await runSetupCommand(LOUD_FAILURE, { cwd: process.cwd(), env: {}, phase: "SPLIT" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TwinError);
    expect((err as TwinError).code).toBe("E_SETUP_FAILED");
    expect((err as TwinError).message).toContain("exit code 3");
    expect(((err as TwinError).details?.logTail as string[]).join("\n")).toContain("could not reach the database");
  }, 30_000);
});
