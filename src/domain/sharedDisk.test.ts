import { describe, expect, it } from "vitest";

import type { Finding } from "./check.js";
import { computeVerdict, verdictHeadline } from "./verdict.js";
import { changedPaths, isWithin, localPathIn, localPathsInEnv, markUnprovenByLocalDisk } from "./sharedDisk.js";

describe("localPathIn", () => {
  it.each([
    ["/var/data/items.json", "/var/data/items.json"],
    ["C:\\data\\app.db", "C:\\data\\app.db"],
    ["C:/data/app.db", "C:/data/app.db"],
    ["sqlite:////home/me/app.sqlite3", "/home/me/app.sqlite3"],
    ["sqlite:///C:/data/app.db", "C:/data/app.db"],
    ["file:/srv/app.db?mode=rwc", "/srv/app.db"]
  ])("reads %s as the local path %s", (value, expected) => {
    expect(localPathIn(value)).toBe(expected);
  });

  it.each(["data.json", "./data.json", "postgres://localhost/app", "https://example.com/x", "//cdn/x", "", "/"])(
    "doesn't read %j as a local path",
    (value) => {
      expect(localPathIn(value)).toBeUndefined();
    }
  );
});

describe("localPathsInEnv", () => {
  it("takes any absolute path the user set for the app, but only data-named ones from the shell", () => {
    const found = localPathsInEnv(
      [
        { vars: { DATA_FILE: "/srv/items.json", CERT: "/etc/ssl/app.pem", NAME: "x" }, ambient: false },
        { vars: { HOME: "/home/me", JAVA_HOME: "/opt/java", UPLOAD_DIR: "/srv/uploads", EDITOR: "/usr/bin/vim", LOGFILE_X: "/l" }, ambient: true }
      ],
      ":"
    );
    expect(found).toEqual([
      { key: "DATA_FILE", path: "/srv/items.json" },
      { key: "CERT", path: "/etc/ssl/app.pem" },
      { key: "UPLOAD_DIR", path: "/srv/uploads" }
    ]);
  });

  it("skips a search path, which is a list of paths, not a store", () => {
    expect(localPathsInEnv([{ vars: { LD_LIBRARY_PATH_X: "/a/lib:/b/lib", MY_DIRS: "C:\\a;C:\\b" }, ambient: false }], ":")).toEqual([]);
    expect(localPathsInEnv([{ vars: { MY_DIRS: "C:\\a;C:\\b" }, ambient: false }], ";")).toEqual([]);
  });
});

describe("isWithin", () => {
  it("matches the root itself and anything under it, but not a sibling with the same prefix", () => {
    expect(isWithin("/tmp/twin-1/shared/data.json", "/tmp/twin-1", "/", false)).toBe(true);
    expect(isWithin("/tmp/twin-1", "/tmp/twin-1/", "/", false)).toBe(true);
    expect(isWithin("/tmp/twin-10/x", "/tmp/twin-1", "/", false)).toBe(false);
    expect(isWithin("C:\\Temp\\Twin-1\\x", "c:/temp/twin-1", "\\", true)).toBe(true);
  });
});

describe("changedPaths", () => {
  it("reports created, modified and deleted files, and not untouched ones", () => {
    const before = new Map([
      ["/a", { size: 1, mtimeMs: 1 }],
      ["/b", { size: 1, mtimeMs: 1 }],
      ["/c", { size: 1, mtimeMs: 1 }]
    ]);
    const after = new Map([
      ["/a", { size: 1, mtimeMs: 1 }],
      ["/b", { size: 2, mtimeMs: 1 }],
      ["/d", { size: 1, mtimeMs: 5 }]
    ]);
    expect(changedPaths(before, after)).toEqual(["/b", "/c", "/d"]);
  });
});

describe("markUnprovenByLocalDisk", () => {
  const pass: Finding = { checkId: "data-consistency", status: "pass", title: "t", summary: "s", evidence: [], suspects: [] };
  const fail: Finding = { ...pass, checkId: "session-survives-switch", status: "fail" };

  it("turns every pass into not-proven, so the run is never called safe", () => {
    const marked = markUnprovenByLocalDisk([pass], ["/tmp/twin-demo-items.json"]);
    expect(marked[0]).toMatchObject({ status: "error", unprovenBy: "shared-local-disk" });
    expect(marked[0]!.summary).toContain("/tmp/twin-demo-items.json");
    expect(verdictHeadline(computeVerdict(marked))).toBe("inconclusive");
  });

  it("leaves failures alone - a real bug is still a real bug", () => {
    const marked = markUnprovenByLocalDisk([pass, fail], ["/tmp/x.json"]);
    expect(marked[1]).toBe(fail);
    expect(verdictHeadline(computeVerdict(marked))).toBe("unsafe");
  });

  it("changes nothing when nothing outside the workspaces was written", () => {
    expect(markUnprovenByLocalDisk([pass], [])).toEqual([pass]);
  });
});
