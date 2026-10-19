import { describe, expect, it } from "vitest";

import { TwinError } from "../../domain/errors.js";
import { runSetupCommand } from "./runSetupCommand.js";

/**
 * Prints a lot first, then the line that says what went wrong, then fails.
 * exitCode, not process.exit(): on Linux and macOS a pipe write can still be
 * queued when process.exit() runs, and exiting that way drops it - which is
 * the fixture losing its own last line, not Twin. A real command exits once
 * its output is flushed.
 */
const LOUD_FAILURE = `node -e "process.stderr.write('x'.repeat(400000) + '\\n'); console.error('could not reach the database'); process.exitCode = 3"`;

describe("runSetupCommand", () => {
  it("resolves when the command exits 0", async () => {
    await expect(runSetupCommand('node -e "0"', { cwd: process.cwd(), env: {}, phase: "CONTROL" })).resolves.toBeUndefined();
  });

  // The logTail is the whole diagnosis Twin prints for a failed setup, and a
  // failing command prints its error last - after any amount of other output.
  it("keeps the command's last line in the logTail, however much it printed first", async () => {
    const err = await runSetupCommand(LOUD_FAILURE, { cwd: process.cwd(), env: {}, phase: "SPLIT" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TwinError);
    expect((err as TwinError).code).toBe("E_SETUP_FAILED");
    expect((err as TwinError).message).toContain("exit code 3");
    expect(((err as TwinError).details?.logTail as string[]).join("\n")).toContain("could not reach the database");
  }, 30_000);

  // Its message is printed, and kept by CI: a secret in the command is masked
  // there as it is in the output.
  it("masks secrets in the command it names when it fails", async () => {
    const redactLine = (line: string): string => line.split("Zq9xS3cret").join("<redacted>");
    const err = await runSetupCommand('node -e "process.exitCode = 4" Zq9xS3cret', { cwd: process.cwd(), env: {}, phase: "CONTROL", redactLine }).catch((e: unknown) => e);

    expect((err as TwinError).message).toContain("<redacted>");
    expect((err as TwinError).message).not.toContain("Zq9xS3cret");
  }, 30_000);
});
