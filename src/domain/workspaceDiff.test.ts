import { describe, expect, it } from "vitest";

import { diffSnapshots, type FsSnapshot } from "./workspaceDiff.js";

function entry(path: string, overrides: Partial<{ size: number; mtimeMs: number; sha1: string }> = {}) {
  return { path, size: 10, mtimeMs: 1000, ...overrides };
}

function snapshot(instance: string, entries: ReturnType<typeof entry>[]): FsSnapshot {
  return { instance, entries };
}

describe("diffSnapshots", () => {
  it("detects an added file", () => {
    const diff = diffSnapshots(snapshot("A", []), snapshot("A", [entry("uploads/x.png")]));
    expect(diff.added.map((e) => e.path)).toEqual(["uploads/x.png"]);
    expect(diff.modified).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("detects a removed file", () => {
    const diff = diffSnapshots(snapshot("A", [entry("data.json")]), snapshot("A", []));
    expect(diff.removed.map((e) => e.path)).toEqual(["data.json"]);
  });

  it("detects a modification via sha1 when available", () => {
    const before = snapshot("A", [entry("data.json", { sha1: "aaa" })]);
    const after = snapshot("A", [entry("data.json", { sha1: "bbb" })]);
    const diff = diffSnapshots(before, after);
    expect(diff.modified.map((e) => e.path)).toEqual(["data.json"]);
  });

  it("falls back to size/mtime when sha1 is unavailable (large files)", () => {
    const before = snapshot("A", [entry("big.bin", { size: 100, mtimeMs: 1 })]);
    const after = snapshot("A", [entry("big.bin", { size: 200, mtimeMs: 2 })]);
    expect(diffSnapshots(before, after).modified).toHaveLength(1);
  });

  it("reports no changes for an identical snapshot", () => {
    const snap = snapshot("A", [entry("x.txt", { sha1: "same" })]);
    const diff = diffSnapshots(snap, snap);
    expect(diff).toEqual({ instance: "A", added: [], modified: [], removed: [] });
  });

  it("tags the diff with the AFTER snapshot's instance id", () => {
    const diff = diffSnapshots(snapshot("A", []), snapshot("A", [entry("x")]));
    expect(diff.instance).toBe("A");
  });
});
