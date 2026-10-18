import { describe, expect, it } from "vitest";

import { quoteForShell } from "./shellQuote.js";

describe("quoteForShell", () => {
  it("double-quotes for cmd.exe, so a path with spaces stays one argument", () => {
    expect(quoteForShell("C:\\Users\\Jane Doe\\AppData\\Local\\twin\\bin\\ab\\app.exe", "win32")).toBe(
      '"C:\\Users\\Jane Doe\\AppData\\Local\\twin\\bin\\ab\\app.exe"'
    );
  });

  it("refuses what cmd.exe can't quote rather than hand it a broken command", () => {
    expect(() => quoteForShell('C:\\a"b', "win32")).toThrow(/double quote/);
  });

  it("single-quotes for sh, escaping single quotes inside", () => {
    expect(quoteForShell("/home/jane doe/.cache/twin/bin/ab/app", "linux")).toBe("'/home/jane doe/.cache/twin/bin/ab/app'");
    expect(quoteForShell("/home/o'brien/app", "darwin")).toBe("'/home/o'\\''brien/app'");
    // $ and backticks are literal inside single quotes.
    expect(quoteForShell("/tmp/$HOME/`x`", "linux")).toBe("'/tmp/$HOME/`x`'");
  });
});
