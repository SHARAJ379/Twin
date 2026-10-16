import { lstat, mkdir, mkdtemp, open, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { diffSnapshots } from "../../domain/workspaceDiff.js";
import { FULL_HASH_LIMIT, FsWorkspaceManager } from "./fsWorkspaceManager.js";

/** Both snapshots get this exact mtime, so only content can explain a diff. */
const FROZEN_TIME = new Date(1_700_000_000_000);

describe("FsWorkspaceManager", () => {
  let sourceDir: string;
  let root: string;

  beforeEach(async () => {
    sourceDir = await mkdtemp(path.join(os.tmpdir(), "twin-src-"));
    root = await mkdtemp(path.join(os.tmpdir(), "twin-root-"));

    await writeFile(path.join(sourceDir, "server.js"), "console.log('hi')");
    await mkdir(path.join(sourceDir, "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(sourceDir, "node_modules", "dep", "index.js"), "module.exports = {}");
    await mkdir(path.join(sourceDir, ".git"), { recursive: true });
    await writeFile(path.join(sourceDir, ".git", "HEAD"), "ref: refs/heads/main");
  });

  afterEach(async () => {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  it("copies real files into the pristine dir but excludes .git and link targets", async () => {
    const manager = new FsWorkspaceManager(root);
    const pristineDir = await manager.preparePristine(sourceDir, { link: ["node_modules"], ignore: [] });

    await expect(readFile(path.join(pristineDir, "server.js"), "utf8")).resolves.toBe("console.log('hi')");
    await expect(lstat(path.join(pristineDir, ".git"))).rejects.toThrow();
    await expect(lstat(path.join(pristineDir, "node_modules"))).rejects.toThrow();
  });

  it("clones the pristine dir per instance and junctions/symlinks the link dirs back to the source", async () => {
    const manager = new FsWorkspaceManager(root);
    const pristineDir = await manager.preparePristine(sourceDir, { link: ["node_modules"], ignore: [] });

    const dirA = await manager.cloneForInstance(pristineDir, "A");
    const dirB = await manager.cloneForInstance(pristineDir, "B");

    expect(dirA).not.toBe(dirB);
    await expect(readFile(path.join(dirA, "server.js"), "utf8")).resolves.toBe("console.log('hi')");
    await expect(readFile(path.join(dirB, "server.js"), "utf8")).resolves.toBe("console.log('hi')");

    // Both instances see the same real node_modules via link, not a copy.
    await expect(readFile(path.join(dirA, "node_modules", "dep", "index.js"), "utf8")).resolves.toBe(
      "module.exports = {}"
    );
    const linkStat = await lstat(path.join(dirA, "node_modules"));
    expect(linkStat.isSymbolicLink()).toBe(true);
  });

  it("cleanup removes everything created under root", async () => {
    const manager = new FsWorkspaceManager(root);
    const pristineDir = await manager.preparePristine(sourceDir, { link: [], ignore: [] });
    await manager.cloneForInstance(pristineDir, "A");

    await manager.cleanup();

    await expect(lstat(root)).rejects.toThrow();
  });

  describe("snapshot", () => {
    it("records every real file with a sha1, excluding .git/.twin/node_modules", async () => {
      const manager = new FsWorkspaceManager(root);
      const pristineDir = await manager.preparePristine(sourceDir, { link: ["node_modules"], ignore: [] });
      const dirA = await manager.cloneForInstance(pristineDir, "A");

      const entries = await manager.snapshot(dirA);

      const paths = entries.map((e) => e.path).sort();
      expect(paths).toEqual(["server.js"]);
      expect(entries[0]!.sha1).toBeDefined();
      expect(entries[0]!.size).toBeGreaterThan(0);
    });

    it("picks up a file added after the clone (the point of snapshotting before/after)", async () => {
      const manager = new FsWorkspaceManager(root);
      const pristineDir = await manager.preparePristine(sourceDir, { link: [], ignore: [] });
      const dirA = await manager.cloneForInstance(pristineDir, "A");

      const before = await manager.snapshot(dirA);
      await mkdir(path.join(dirA, "uploads"), { recursive: true });
      await writeFile(path.join(dirA, "uploads", "x.png"), "fake-image-bytes");
      const after = await manager.snapshot(dirA);

      expect(before.map((e) => e.path)).not.toContain("uploads/x.png");
      expect(after.map((e) => e.path)).toContain("uploads/x.png");
    });

    it("returns [] for a directory that no longer exists rather than throwing", async () => {
      const manager = new FsWorkspaceManager(root);
      expect(await manager.snapshot(path.join(root, "nope"))).toEqual([]);
    });

    it("detects a rewrite that keeps the same size and mtime, which size/mtime comparison could not", async () => {
      const manager = new FsWorkspaceManager(root);
      const dir = await manager.cloneForInstance(await manager.preparePristine(sourceDir, { link: [], ignore: [] }), "A");
      const file = path.join(dir, "data.json");

      await writeFile(file, '{"items":["aaaa"]}');
      await utimes(file, FROZEN_TIME, FROZEN_TIME);
      const before = await manager.snapshot(dir);

      // Same byte length, same timestamp - the shape an in-place record update
      // takes on a filesystem with coarse mtime granularity.
      await writeFile(file, '{"items":["bbbb"]}');
      await utimes(file, FROZEN_TIME, FROZEN_TIME);
      const after = await manager.snapshot(dir);

      const beforeEntry = before.find((e) => e.path === "data.json");
      const afterEntry = after.find((e) => e.path === "data.json");
      expect(afterEntry?.size).toBe(beforeEntry?.size);
      expect(afterEntry?.mtimeMs).toBe(beforeEntry?.mtimeMs);
      expect(afterEntry?.sha1).not.toBe(beforeEntry?.sha1);
      expect(diffSnapshots({ instance: "A", entries: before }, { instance: "A", entries: after }).modified).toHaveLength(1);
    });

    it("fingerprints a file past the full-hash limit by sampling, and marks it as sampled", async () => {
      const manager = new FsWorkspaceManager(root);
      const dir = await manager.cloneForInstance(await manager.preparePristine(sourceDir, { link: [], ignore: [] }), "A");
      const file = path.join(dir, "huge.db");

      // truncate() sizes the file without writing 64MB of bytes.
      const handle = await open(file, "w");
      await handle.truncate(FULL_HASH_LIMIT + 4096);
      await handle.close();
      await utimes(file, FROZEN_TIME, FROZEN_TIME);

      const before = await manager.snapshot(dir);
      const entry = before.find((e) => e.path === "huge.db");
      expect(entry?.sampled).toBe(true);
      expect(entry?.sha1).toEqual(expect.any(String));

      // A write inside the sampled head is caught by the fingerprint itself,
      // mtime or no mtime.
      const head = await open(file, "r+");
      await head.write(Buffer.from("changed"), 0, 7, 0);
      await head.close();
      await utimes(file, FROZEN_TIME, FROZEN_TIME); // so only the fingerprint can explain the diff

      const after = await manager.snapshot(dir);
      expect(after.find((e) => e.path === "huge.db")?.sha1).not.toBe(entry?.sha1);
      expect(diffSnapshots({ instance: "A", entries: before }, { instance: "A", entries: after }).modified).toHaveLength(1);
    }, 60_000);
  });

  describe("a re-clone is a clean disk", () => {
    /**
     * What `restart` with `disk: "fresh"` depends on. The clone used to copy
     * the pristine tree *into* whatever was already at the destination, so a
     * file the app created at runtime - a SQLite db, a JSON store - was not in
     * the pristine tree, nothing overwrote it, and it survived. An app that
     * keeps its data in a runtime-created file then passed restart-persistence,
     * which is precisely the app that check exists to fail.
     */
    it("removes files the app created at runtime", async () => {
      const manager = new FsWorkspaceManager(root);
      const pristineDir = await manager.preparePristine(sourceDir, { link: ["node_modules"], ignore: [] });

      const first = await manager.cloneForInstance(pristineDir, "A");
      await writeFile(path.join(first, "runtime.db"), "rows the app wrote");
      await mkdir(path.join(first, "uploads"), { recursive: true });
      await writeFile(path.join(first, "uploads", "avatar.png"), "bytes");

      const second = await manager.cloneForInstance(pristineDir, "A");

      expect(second).toBe(first); // same path, as restart relies on
      await expect(readFile(path.join(second, "runtime.db"), "utf8")).rejects.toThrow();
      await expect(readFile(path.join(second, "uploads", "avatar.png"), "utf8")).rejects.toThrow();
      // and the project's own files are still there
      expect(await readFile(path.join(second, "server.js"), "utf8")).toBe("console.log('hi')");
    });

    /**
     * The clone removes its destination, and the destination contains a
     * junction to the real project's node_modules. If that removal ever
     * followed the link instead of unlinking it, Twin would delete the user's
     * actual dependencies - the one thing it promises never to touch (I2).
     */
    it("never deletes through the dependency link into the real project", async () => {
      const manager = new FsWorkspaceManager(root);
      const pristineDir = await manager.preparePristine(sourceDir, { link: ["node_modules"], ignore: [] });

      await manager.cloneForInstance(pristineDir, "A");
      await manager.cloneForInstance(pristineDir, "A");

      expect(await readFile(path.join(sourceDir, "node_modules", "dep", "index.js"), "utf8")).toBe("module.exports = {}");
    });
  });

  /**
   * npm workspaces and monorepos have a node_modules per package. The copy
   * filter drops every one of them by name, so linking only the root one back
   * left the nested packages with no dependencies at all and the app couldn't
   * boot.
   */
  it("links a nested dependency directory, not just the one at the root", async () => {
    await mkdir(path.join(sourceDir, "packages", "web", "node_modules", "left-pad"), { recursive: true });
    await writeFile(path.join(sourceDir, "packages", "web", "node_modules", "left-pad", "index.js"), "module.exports = 1");
    await writeFile(path.join(sourceDir, "packages", "web", "app.js"), "require('left-pad')");

    const manager = new FsWorkspaceManager(root);
    const pristineDir = await manager.preparePristine(sourceDir, { link: ["node_modules"], ignore: [] });
    const dir = await manager.cloneForInstance(pristineDir, "A");

    const nested = path.join(dir, "packages", "web", "node_modules");
    expect((await lstat(nested)).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(nested, "left-pad", "index.js"), "utf8")).toBe("module.exports = 1");
    // the package's own source still came through as a copy
    expect(await readFile(path.join(dir, "packages", "web", "app.js"), "utf8")).toBe("require('left-pad')");
  });
});
