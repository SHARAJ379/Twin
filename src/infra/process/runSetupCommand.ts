import { spawn } from "node:child_process";

import { TwinError } from "../../domain/errors.js";
import { createLogSink } from "./logSink.js";

/** A reset that takes longer than this is stuck, not slow. */
const SETUP_TIMEOUT_MS = 5 * 60_000;

/**
 * Runs the project's `setup` command (`npm run db:reset`, say) in the project
 * itself, with the environment its instances get, before a phase boots any
 * of them. Each phase then starts from the same known state - and the
 * records a run creates land in a database the user chose to throw away,
 * rather than piling up in their dev database run after run.
 */
export async function runSetupCommand(
  command: string,
  options: { cwd: string; env: Record<string, string>; phase: string; redactLine?: (line: string) => string }
): Promise<void> {
  const logs = createLogSink({ redactLine: options.redactLine });
  // As the errors below print it: their message reaches the terminal, and CI's log.
  const shown = options.redactLine?.(command) ?? command;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      // TWIN_PHASE lets one script do different things per phase, if it must.
      env: { ...process.env, ...options.env, TWIN_PHASE: options.phase },
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: SETUP_TIMEOUT_MS
    });
    child.stdout?.on("data", (chunk: Buffer) => logs.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => logs.write(chunk));
    child.once("error", (err) => {
      reject(
        new TwinError("E_SETUP_FAILED", `Failed to run the setup command \`${shown}\` before ${options.phase}.`, {
          hint: 'Check "setup" in twin.config.json (or --setup).',
          details: { phase: options.phase },
          cause: err
        })
      );
    });
    // 'close', not 'exit': Node documents that a child's stdio may still be
    // open when 'exit' fires, and a failing command prints its actual error
    // last. 'close' comes once the output has all been read.
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new TwinError(
          "E_SETUP_FAILED",
          `The setup command \`${shown}\` failed before ${options.phase} (exit code ${code ?? "null"}, signal ${signal ?? "null"}).`,
          {
            hint: "Run it yourself to see the full error. Twin stops here rather than run the scenario against a database in an unknown state.",
            details: { phase: options.phase, logTail: logs.lines(30) }
          }
        )
      );
    });
  });
}
