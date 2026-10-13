import { describe, expect, it } from "vitest";

import { diffSnapshots, type FsSnapshot } from "./workspaceDiff.js";

function entry(path: string, overrides: Partial<{ size: number; mtimeMs: number; sha1: string; sampled: boolean }> = {}) {
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

  it("reports a file with no hash as changed, because unreadable is indeterminate - not unchanged", () => {
    // This used to fall back to size + mtime, so a file rewritten in place at
    // the same size, with an mtime collision from coarse filesystem
    // granularity, was reported as identical and the tracer lost the evidence.
    const before = snapshot("A", [entry("big.bin", { size: 100, mtimeMs: 1 })]);
    const after = snapshot("A", [entry("big.bin", { size: 100, mtimeMs: 1 })]);
    expect(diffSnapshots(before, after).modified.map((e) => e.path)).toEqual(["big.bin"]);
  });

  it("reports a change when only one side could be hashed", () => {
    const before = snapshot("A", [entry("big.bin", { sha1: "aaa" })]);
    const after = snapshot("A", [entry("big.bin")]);
    expect(diffSnapshots(before, after).modified).toHaveLength(1);
    expect(diffSnapshots(after, before).modified).toHaveLength(1);
  });

  it("accepts matching sampled fingerprints as unchanged only while size and mtime agree too", () => {
    const sampled = (overrides: { mtimeMs?: number; size?: number }) =>
      snapshot("A", [entry("huge.db", { sha1: "sampled-match", sampled: true, size: 10, mtimeMs: 1000, ...overrides })]);

    expect(diffSnapshots(sampled({}), sampled({})).modified).toEqual([]);
    // The hash only covers head/middle/tail, so a touched mtime is reason
    // enough to suspect a write landed in between.
    expect(diffSnapshots(sampled({}), sampled({ mtimeMs: 2000 })).modified).toHaveLength(1);
    expect(diffSnapshots(sampled({}), sampled({ size: 11 })).modified).toHaveLength(1);
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
