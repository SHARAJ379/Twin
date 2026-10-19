import { readFile, writeFile } from "node:fs/promises";

export interface PidRecord {
  pid: number;
  instance: string;
  /** The start command we spawned, e.g. "npm start" - used as a loose fingerprint against PID reuse. */
  command: string;
  startedAt: string;
}

/**
 * A pid an instance Twin spawned could actually have. `twin clean` signals
 * `-pid`, and on POSIX kill(-1) reaches every process the user owns and
 * kill(0) Twin's own group - so 0, 1 and anything negative or fractional,
 * which no spawned child ever gets, must never come out of a pids.json.
 */
export function isSpawnedPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1;
}

function isPidRecord(value: unknown): value is PidRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    isSpawnedPid(r["pid"]) &&
    typeof r["instance"] === "string" &&
    // An empty command fingerprints to "", which every command line contains.
    typeof r["command"] === "string" &&
    r["command"].trim().length > 0 &&
    typeof r["startedAt"] === "string"
  );
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
