import { describe, expect, it } from "vitest";

import { createLogRedactor } from "../../domain/logRedaction.js";
import type { Logger } from "../../ports/logger.js";
import { RedactingLogger } from "./redactingLogger.js";

function recorder(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger: Logger = {
    debug: (message, meta) => lines.push(message + JSON.stringify(meta ?? {})),
    info: (message, meta) => lines.push(message + JSON.stringify(meta ?? {})),
    warn: (message, meta) => lines.push(message + JSON.stringify(meta ?? {})),
    error: (message, meta) => lines.push(message + JSON.stringify(meta ?? {})),
    child: (bindings) => {
      const inner = logger;
      return { ...inner, info: (message, meta) => inner.info(message, { ...bindings, ...meta }) };
    }
  };
  return { logger, lines };
}

describe("RedactingLogger", () => {
  it("masks the message and every string in the metadata, at any depth", () => {
    const { logger, lines } = recorder();
    const log = new RedactingLogger(logger, createLogRedactor(["Hx7EnvSecretValue"]));

    log.info("stack: Node.js", { start: "node s.js --token=supersecret123456", build: "API_KEY=sk_9f8e7d6c5b4a39281 npm run build" });
    log.warn("boot failed: Hx7EnvSecretValue", { nested: { list: ["x Hx7EnvSecretValue y"] }, pid: 42 });
    log.error("e", { error: "postgres://app:pw12345@db/app" });
    log.debug("d", { hint: "Bearer abcdefgh12345678" });

    const out = lines.join("\n");
    for (const secret of ["supersecret123456", "sk_9f8e7d6c5b4a39281", "Hx7EnvSecretValue", "pw12345", "abcdefgh12345678"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('"pid":42');
    expect(out).toContain("node s.js --token=<redacted>");
  });

  it("masks a child logger's bindings and lines too", () => {
    const { logger, lines } = recorder();
    const log = new RedactingLogger(logger, createLogRedactor()).child({ command: "node s.js --password=hunter2hunter2" });

    log.info("started", { extra: "token=abc123def456" });

    expect(lines.join("\n")).not.toMatch(/hunter2hunter2|abc123def456/);
  });
});
