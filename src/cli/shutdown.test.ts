import { afterEach, describe, expect, it } from "vitest";

import type { Logger } from "../ports/logger.js";
import { onShutdown, resetShutdownHandlersForTest, runShutdownHooks } from "./shutdown.js";

function recordingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string) => {
      warnings.push(message);
    },
    error: () => undefined,
    child: () => logger
  };
  return { warnings, logger };
}

afterEach(() => {
  resetShutdownHandlersForTest();
});

describe("shutdown hooks", () => {
  it("runs every registered hook", async () => {
    const ran: string[] = [];
    onShutdown(() => {
      ran.push("first");
    });
    onShutdown(async () => {
      await Promise.resolve();
      ran.push("second");
    });

    await runShutdownHooks(1000, recordingLogger().logger);
    expect(ran.sort()).toEqual(["first", "second"]);
  });

  it("does not run a hook that was unregistered", async () => {
    const ran: string[] = [];
    const unregister = onShutdown(() => {
      ran.push("stale");
    });
    unregister();

    await runShutdownHooks(1000, recordingLogger().logger);
    expect(ran).toEqual([]);
  });

  it("keeps going when one hook throws, and says so", async () => {
    const ran: string[] = [];
    onShutdown(() => {
      throw new Error("kill failed");
    });
    onShutdown(() => {
      ran.push("still ran");
    });
    const { logger, warnings } = recordingLogger();

    await runShutdownHooks(1000, logger);

    expect(ran).toEqual(["still ran"]);
    expect(warnings.join(" ")).toContain("teardown step failed");
  });

  it("gives up on a hook that hangs, so Ctrl-C can never trap the user", async () => {
    onShutdown(() => new Promise<void>(() => undefined)); // never settles
    const { logger, warnings } = recordingLogger();

    const started = Date.now();
    await runShutdownHooks(200, logger);

    expect(Date.now() - started).toBeLessThan(5000);
    expect(warnings.join(" ")).toContain("twin clean");
  });
});
