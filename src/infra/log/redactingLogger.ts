import type { Logger } from "../../ports/logger.js";

/**
 * Masks every line before it reaches the logger underneath: the message and
 * every string in its metadata, however deeply nested. Masking at each call
 * site missed one (the start command on the "stack:" line went to CI logs
 * verbatim), so it happens here, where no log call can skip it.
 */
export class RedactingLogger implements Logger {
  constructor(
    private readonly inner: Logger,
    private readonly redact: (line: string) => string
  ) {}

  debug(message: string, meta?: Record<string, unknown>): void {
    this.inner.debug(this.redact(message), this.redactMeta(meta));
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.inner.info(this.redact(message), this.redactMeta(meta));
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.inner.warn(this.redact(message), this.redactMeta(meta));
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.inner.error(this.redact(message), this.redactMeta(meta));
  }

  child(bindings: Record<string, unknown>): Logger {
    return new RedactingLogger(this.inner.child(redactValue(bindings, this.redact) as Record<string, unknown>), this.redact);
  }

  private redactMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    return meta === undefined ? undefined : (redactValue(meta, this.redact) as Record<string, unknown>);
  }
}

function redactValue(value: unknown, redact: (line: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redact));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, redact)]));
  }
  return value;
}
