import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsWorkspaceManager } from "./fsWorkspaceManager.js";

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
  });
});
