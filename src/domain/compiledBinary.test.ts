import { describe, expect, it } from "vitest";

import { compiledBinaryPath, userCacheDir } from "./compiledBinary.js";

const windows = {
  platform: "win32" as const,
  env: { LOCALAPPDATA: "C:\\Users\\Jane Doe\\AppData\\Local" },
  homedir: "C:\\Users\\Jane Doe"
};
const linux = { platform: "linux" as const, env: {}, homedir: "/home/jane" };
const mac = { platform: "darwin" as const, env: {}, homedir: "/Users/jane" };

describe("userCacheDir", () => {
  it("is where Go's os.UserCacheDir() would put it on each OS", () => {
    expect(userCacheDir(windows)).toBe("C:\\Users\\Jane Doe\\AppData\\Local");
    expect(userCacheDir({ ...windows, env: {} })).toBe("C:\\Users\\Jane Doe\\AppData\\Local");
    expect(userCacheDir(mac)).toBe("/Users/jane/Library/Caches");
    expect(userCacheDir(linux)).toBe("/home/jane/.cache");
    expect(userCacheDir({ ...linux, env: { XDG_CACHE_HOME: "/var/cache/jane" } })).toBe("/var/cache/jane");
    // The XDG spec says a relative value is invalid and must be ignored.
    expect(userCacheDir({ ...linux, env: { XDG_CACHE_HOME: "cache" } })).toBe("/home/jane/.cache");
  });
});

/**
 * Windows Firewall keys its "allow this app?" prompt to an executable's path:
 * a new path per run (what `go run` produced) asked again on every run.
 */
describe("compiledBinaryPath", () => {
  it("is <user cache dir>/twin/bin/<hash of the project path>/<folder name>[.exe]", () => {
    expect(compiledBinaryPath({ ...windows, projectDir: "C:\\code\\broken-go" })).toMatch(
      /^C:\\Users\\Jane Doe\\AppData\\Local\\twin\\bin\\[0-9a-f]{16}\\broken-go\.exe$/
    );
    expect(compiledBinaryPath({ ...linux, projectDir: "/home/jane/code/broken-go" })).toMatch(
      /^\/home\/jane\/\.cache\/twin\/bin\/[0-9a-f]{16}\/broken-go$/
    );
    expect(compiledBinaryPath({ ...mac, projectDir: "/Users/jane/code/broken-go" })).toMatch(
      /^\/Users\/jane\/Library\/Caches\/twin\/bin\/[0-9a-f]{16}\/broken-go$/
    );
  });

  it("is the same on every run of a project, and differs between projects", () => {
    const a = compiledBinaryPath({ ...linux, projectDir: "/home/jane/code/shop" });
    expect(compiledBinaryPath({ ...linux, projectDir: "/home/jane/code/shop" })).toBe(a);
    expect(compiledBinaryPath({ ...linux, projectDir: "/home/jane/code/shop/" })).toBe(a);
    // Same folder name, different project: a different directory, not a clash.
    expect(compiledBinaryPath({ ...linux, projectDir: "/home/jane/old/shop" })).not.toBe(a);
  });

  it("treats Windows paths that differ only in case as one project, and one executable", () => {
    expect(compiledBinaryPath({ ...windows, projectDir: "C:\\Code\\Shop" })).toBe(compiledBinaryPath({ ...windows, projectDir: "c:\\code\\shop" }));
  });

  it("names the executable after the project folder, made safe for a file name", () => {
    expect(compiledBinaryPath({ ...linux, projectDir: "/home/jane/my app (v2)" })).toMatch(/\/my-app--v2-$/);
    expect(compiledBinaryPath({ ...linux, projectDir: "/" })).toMatch(/\/app$/);
    expect(compiledBinaryPath({ ...linux, projectDir: "/home/jane/.hidden" })).toMatch(/\/hidden$/);
  });
});
