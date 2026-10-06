import type { LogLevel, Logger } from "../../ports/logger.js";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface ConsoleLoggerOptions {
  /** Minimum level to print. Defaults to "info", or "debug" if TWIN_DEBUG=1. */
  level?: LogLevel;
  /** Disables ANSI color (also auto-disabled when NO_COLOR is set or stdout isn't a TTY). */
  color?: boolean;
}

const COLOR_BY_LEVEL: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m"
};
const RESET = "\x1b[0m";

/** Default Logger implementation: debug/info -> stdout, warn/error -> stderr. */
export class ConsoleLogger implements Logger {
  private readonly level: LogLevel;
  private readonly color: boolean;
  private readonly bindings: Record<string, unknown>;

  constructor(options: ConsoleLoggerOptions = {}, bindings: Record<string, unknown> = {}) {
    this.level = options.level ?? (process.env["TWIN_DEBUG"] === "1" ? "debug" : "info");
    this.color = options.color ?? (process.env["NO_COLOR"] === undefined && process.stdout.isTTY === true);
    this.bindings = bindings;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write("debug", message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write("error", message, meta);
  }

  child(bindings: Record<string, unknown>): Logger {
    return new ConsoleLogger({ level: this.level, color: this.color }, { ...this.bindings, ...bindings });
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const merged = { ...this.bindings, ...meta };
    const suffix = Object.keys(merged).length > 0 ? ` ${JSON.stringify(merged)}` : "";
    const tag = level.toUpperCase().padEnd(5);
    const line = this.color
      ? `${COLOR_BY_LEVEL[level]}${tag}${RESET} ${message}${suffix}`
      : `${tag} ${message}${suffix}`;

    if (level === "warn" || level === "error") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }
}
