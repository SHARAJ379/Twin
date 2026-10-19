import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readPidFile } from "./pidFile.js";

const dirs: string[] = [];

async function pidFileWith(records: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "twin-pidfile-"));
  dirs.push(dir);
  const file = path.join(dir, "pids.json");
  await writeFile(file, JSON.stringify(records), "utf8");
  return file;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("readPidFile", () => {
  it("keeps a record Twin itself would write", async () => {
    const record = { pid: 4242, instance: "A", command: "npm start", startedAt: "2026-01-01T00:00:00.000Z" };
    expect(await readPidFile(await pidFileWith([record]))).toEqual([record]);
  });

  // `twin clean` signals -pid. On POSIX, kill(-1) reaches every process the
  // user owns and kill(0) Twin's own process group, so a pids.json in a
  // project's .twin/ must never be able to name either.
  it("drops pids that no process Twin started could have: 0, 1, negative, fractional", async () => {
    const at = "2026-01-01T00:00:00.000Z";
    const records = [0, 1, -1, -4242, 1.5, 1e300].map((pid) => ({ pid, instance: "A", command: "npm start", startedAt: at }));
    expect(await readPidFile(await pidFileWith(records))).toEqual([]);
  });

  // An empty command fingerprints to "", which every live command line contains.
  it("drops a record with no command to recognise the process by", async () => {
    const records = [
      { pid: 4242, instance: "A", command: "", startedAt: "2026-01-01T00:00:00.000Z" },
      { pid: 4243, instance: "A", command: "   ", startedAt: "2026-01-01T00:00:00.000Z" }
    ];
    expect(await readPidFile(await pidFileWith(records))).toEqual([]);
  });
});
