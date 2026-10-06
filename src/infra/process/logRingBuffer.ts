import type { LogTail } from "../../ports/instanceDriver.js";

const DEFAULT_CAPACITY = 500;

/** Captures a process's stdout/stderr as lines, keeping only the most recent `capacity`. */
export class LogRingBuffer implements LogTail {
  private readonly buffer: string[] = [];
  private partial = "";

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  write(chunk: Buffer | string): void {
    const text = this.partial + chunk.toString("utf8");
    const parts = text.split("\n");
    this.partial = parts.pop() ?? "";
    for (const line of parts) {
      this.buffer.push(line);
      if (this.buffer.length > this.capacity) this.buffer.shift();
    }
  }

  lines(count: number): string[] {
    const all = this.partial.length > 0 ? [...this.buffer, this.partial] : this.buffer;
    return all.slice(-count);
  }
}
