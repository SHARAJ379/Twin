import { describe, expect, it } from "vitest";

import { createLogSink } from "./logSink.js";

function fakeFile(): { written: string[]; isEnded: () => boolean; file: { write(t: string): void; end(): void } } {
  const written: string[] = [];
  let ended = false;
  return {
    written,
    isEnded: () => ended,
    file: {
      write: (text: string) => {
        written.push(text);
      },
      end: () => {
        ended = true;
      }
    }
  };
}

const maskSecret = (line: string): string => line.split("hunter2").join("<redacted>");

describe("createLogSink", () => {
  it("keeps complete lines and their terminators intact", () => {
    const sink = createLogSink();
    sink.write("one\ntwo\n");
    expect(sink.lines(10)).toEqual(["one", "two"]);
  });

  it("redacts a secret split across two chunks (the reason redaction is per-line)", () => {
    const sink = createLogSink({ redactLine: maskSecret });
    sink.write("db=postgres://app:hun");
    sink.write("ter2@db.example.com\n");
    expect(sink.lines(10)).toEqual(["db=postgres://app:<redacted>@db.example.com"]);
  });

  it("reports the trailing partial line, redacted - an app that dies mid-line still gets diagnosed", () => {
    const sink = createLogSink({ redactLine: maskSecret });
    sink.write("FATAL: bad password hunter2");
    expect(sink.lines(10)).toEqual(["FATAL: bad password <redacted>"]);
  });

  it("counts the trailing partial against the requested line count", () => {
    const sink = createLogSink();
    sink.write("a\nb\nc\npartial");
    expect(sink.lines(2)).toEqual(["c", "partial"]);
  });

  it("writes redacted text to the file, never the raw line", () => {
    const f = fakeFile();
    const sink = createLogSink({ redactLine: maskSecret, file: f.file });
    sink.write("secret is hunter2\n");
    expect(f.written.join("")).toBe("secret is <redacted>\n");
    expect(f.written.join("")).not.toContain("hunter2");
  });

  it("flushes the redacted partial and ends the file on close", () => {
    const f = fakeFile();
    const sink = createLogSink({ redactLine: maskSecret, file: f.file });
    sink.write("crashed with hunter2");
    sink.close();
    expect(f.written.join("")).toBe("crashed with <redacted>");
    expect(f.isEnded()).toBe(true);
    expect(sink.lines(10)).toEqual(["crashed with <redacted>"]);
  });

  it("ignores a write that lands after close, rather than writing to an ended stream", () => {
    const f = fakeFile();
    const sink = createLogSink({ file: f.file });
    sink.close();
    sink.write("late output\n");
    expect(f.written).toEqual([]);
    expect(sink.lines(10)).toEqual([]);
  });

  it("is idempotent on close", () => {
    const f = fakeFile();
    const sink = createLogSink({ file: f.file });
    sink.write("done");
    sink.close();
    sink.close();
    expect(f.written.join("")).toBe("done");
  });

  it("accepts Buffer chunks, decoding them as utf8", () => {
    const sink = createLogSink();
    sink.write(Buffer.from("héllo\n", "utf8"));
    expect(sink.lines(10)).toEqual(["héllo"]);
  });

  it("drops the oldest lines past its capacity", () => {
    const sink = createLogSink({ capacity: 2 });
    sink.write("a\nb\nc\n");
    expect(sink.lines(10)).toEqual(["b", "c"]);
  });
});
