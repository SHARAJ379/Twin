import type { LogTail } from "../../ports/instanceDriver.js";
import { LogRingBuffer } from "./logRingBuffer.js";

/** Where a sink persists its (already redacted) output, beyond the in-memory tail. */
export interface LogFile {
  write(text: string): void;
  end(): void;
}

export interface LogSink extends LogTail {
  write(chunk: Buffer | string): void;
  close(): void;
}

export interface LogSinkOptions {
  /** Applied to every line before it reaches memory or disk. Identity by default. */
  redactLine?: ((line: string) => string) | undefined;
  file?: LogFile | undefined;
  capacity?: number | undefined;
}

/**
 * Captures a process's output twice over - an in-memory tail for the `logTail`
 * on a boot failure, and (optionally) a file readable after the run - with
 * every line passed through a redactor first.
 *
 * Redaction happens per *line*, not per chunk: stdout arrives in arbitrary
 * slices, so a secret can straddle two chunks and a chunk-level regex would
 * miss it. So whole lines are released as soon as a newline arrives, and the
 * trailing partial is held back - but still reported by `lines()`, redacted,
 * because an app that dies without a trailing newline usually just printed the
 * most important line of the whole run.
 */
export function createLogSink(options: LogSinkOptions = {}): LogSink {
  const redact = options.redactLine ?? ((line: string): string => line);
  const buffer = new LogRingBuffer(options.capacity);
  const file = options.file;
  let pending = "";
  let closed = false;

  const emit = (text: string): void => {
    buffer.write(text);
    file?.write(text);
  };

  return {
    write(chunk: Buffer | string): void {
      // A stdio 'data' event can still land after the sink was closed (the
      // child's 'exit' can precede its pipes draining). Dropping it is better
      // than writing to an ended stream, which throws asynchronously.
      if (closed) return;
      pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");

      const lastNewline = pending.lastIndexOf("\n");
      if (lastNewline === -1) return;
      const complete = pending.slice(0, lastNewline + 1);
      pending = pending.slice(lastNewline + 1);
      // split/join keeps the terminators exactly as they came in: the final
      // element after a trailing "\n" is "", which the redactor returns as-is.
      emit(complete.split("\n").map(redact).join("\n"));
    },

    lines(count: number): string[] {
      const complete = buffer.lines(count);
      if (pending.length === 0) return complete;
      return [...complete, redact(pending)].slice(-count);
    },

    close(): void {
      if (closed) return;
      closed = true;
      if (pending.length > 0) {
        const tail = redact(pending);
        pending = "";
        // The newline is for the ring buffer's line splitter only - the file
        // gets exactly what the app wrote, minus the secrets.
        buffer.write(`${tail}\n`);
        file?.write(tail);
      }
      file?.end();
    }
  };
}
