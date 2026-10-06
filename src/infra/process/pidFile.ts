import { readFile, writeFile } from "node:fs/promises";

export interface PidRecord {
  pid: number;
  instance: string;
  /** The start command we spawned, e.g. "npm start" - used as a loose fingerprint against PID reuse. */
  command: string;
  startedAt: string;
}

function isPidRecord(value: unknown): value is PidRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r["pid"] === "number" && typeof r["instance"] === "string" && typeof r["command"] === "string" && typeof r["startedAt"] === "string";
}

export async function writePidFile(filePath: string, records: PidRecord[]): Promise<void> {
  await writeFile(filePath, JSON.stringify(records, null, 2), "utf8");
}

/** Never throws: a missing or corrupt pids.json just means "nothing to reap". */
export async function readPidFile(filePath: string): Promise<PidRecord[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isPidRecord) : [];
  } catch {
    return [];
  }
}
