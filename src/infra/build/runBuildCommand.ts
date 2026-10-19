import { spawn } from "node:child_process";

import { TwinError } from "../../domain/errors.js";
import { createLogSink } from "../process/logSink.js";

export interface BuildCommandOptions {
  cwd: string;
  /** What it builds, as the error names it: "instance A", "the project". */
  target: string;
  /** The environment to run it with. Twin's own, when omitted. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Merged into the error's details. */
  details?: Record<string, unknown> | undefined;
  hint?: string | undefined;
  redactLine?: ((line: string) => string) | undefined;
}

/** Runs a build command to completion, before anything boots. Rejects with TwinError("E_BUILD_FAILED") on a non-zero exit. */
export async function runBuildCommand(command: string, options: BuildCommandOptions): Promise<void> {
  // Redacted like any other captured output: a failing build prints the
  // environment it was given more often than an app does.
  const logs = createLogSink({ redactLine: options.redactLine });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.on("data", (chunk: Buffer) => logs.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => logs.write(chunk));
    child.once("error", (err) => {
      reject(
        new TwinError("E_BUILD_FAILED", `Failed to run build command \`${command}\` for ${options.target}.`, {
          details: { ...options.details },
          cause: err
        })
      );
    });
    // 'close', not 'exit': see runSetupCommand - the error a failing build
    // prints last could still be in the pipes when 'exit' fired.
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new TwinError(
          "E_BUILD_FAILED",
          `Build command \`${command}\` failed for ${options.target} (exit code ${code ?? "null"}, signal ${signal ?? "null"}).`,
          {
            hint: options.hint ?? "Run the build command manually to see the full error.",
            details: { ...options.details, logTail: logs.lines(30) }
          }
        )
      );
    });
  });
}
