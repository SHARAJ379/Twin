import type { Logger } from "../ports/logger.js";

/**
 * Ctrl-C used to be Twin's messiest exit: on POSIX every instance is spawned
 * into its own process group (so killTree can signal the whole tree), which
 * also means the shell's SIGINT never reaches them. The run died, three app
 * processes kept their ports, and a full copy of the project per instance
 * stayed in the temp dir. `twin clean` could reap the processes afterwards -
 * but only if the user knew to run it.
 *
 * So the CLI installs one handler that gives whatever is running a chance to
 * tear itself down first. A second signal gives up and exits immediately,
 * because a hung teardown must never trap the user in their own terminal.
 */
export type ShutdownHook = () => Promise<void> | void;

const hooks = new Set<ShutdownHook>();
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
/** 130 = 128 + SIGINT, the shell convention for "killed by this signal". */
const EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

let installed = false;
let shuttingDown = false;

/** Registers a teardown hook. Call the returned function once the work it guards is done. */
export function onShutdown(hook: ShutdownHook): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

/** Test seam: the module holds process-wide state, which has to be resettable. */
export function resetShutdownHandlersForTest(): void {
  hooks.clear();
  installed = false;
  shuttingDown = false;
}

export async function runShutdownHooks(timeoutMs: number, logger: Logger): Promise<void> {
  const pending = [...hooks].map(async (hook) => {
    try {
      await hook();
    } catch (err) {
      logger.warn("a teardown step failed during shutdown", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  });

  // unref: this timer must never be the reason the process stays alive.
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref();
  });

  try {
    const outcome = await Promise.race([Promise.all(pending).then(() => "done" as const), budget]);
    if (outcome === "timeout") {
      logger.warn(`teardown did not finish within ${timeoutMs}ms - run \`twin clean\` to reap anything left behind`);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function installShutdownHandlers(logger: Logger, timeoutMs = 10_000): void {
  if (installed) return;
  installed = true;

  for (const signal of SIGNALS) {
    // Registering any listener suppresses Node's default "die now" behavior,
    // which is what buys the teardown its window.
    process.on(signal, () => {
      const code = EXIT_CODES[signal] ?? 1;
      if (shuttingDown) {
        logger.warn(`${signal} again - exiting now; run \`twin clean\` to reap anything left behind`);
        process.exit(code);
      }
      shuttingDown = true;
      logger.warn(`${signal} - stopping instances and removing temp workspaces (Ctrl-C again to exit immediately)`);

      void runShutdownHooks(timeoutMs, logger).then(
        () => process.exit(code),
        () => process.exit(code)
      );
    });
  }
}
