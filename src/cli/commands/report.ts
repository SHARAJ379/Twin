import { readFile } from "node:fs/promises";

import { TwinError } from "../../domain/errors.js";
import { FsArtifactStore } from "../../infra/artifacts/fsArtifactStore.js";
import { computeExitCode } from "../../report/exitCode.js";
import type { ReportJson } from "../../report/reportJson.js";
import { renderTerminalReport } from "../../report/terminal.js";

export type ReportFormat = "terminal" | "json" | "markdown";

export interface ReportOptions {
  projectDir: string;
  /** Defaults to the most recent run (`.twin/latest`). */
  run?: string | undefined;
  format: ReportFormat;
}

/** `twin report`: re-prints a past `twin run`'s report without re-running anything. */
export async function reportCommand(options: ReportOptions, print: (text: string) => void): Promise<number> {
  const store = new FsArtifactStore(options.projectDir);

  const runId = options.run ?? (await store.readLatestRunId());
  if (runId === undefined) {
    throw new TwinError("E_NO_REPORT", "no Twin runs found in this project", {
      hint: "Run `twin run --scenario <path>` first.",
      exitCode: 2
    });
  }
  const run = store.getRun(runId);
  const reportJson = await readReportJson(store, run, runId);

  if (options.format === "markdown") {
    print(await readReportFile(store.pathFor(run, "report.md"), runId));
  } else if (options.format === "json") {
    print(JSON.stringify(reportJson, null, 2));
  } else {
    print(renderTerminalReport(reportJson.findings, reportJson.verdict, reportJson.profile));
  }
  return computeExitCode(reportJson.verdict);
}

async function readReportFile(filePath: string, runId: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    throw new TwinError("E_NO_REPORT", `no report found for run "${runId}"`, {
      hint: "Check the run id, or omit --run to use the latest one.",
      cause: err,
      exitCode: 2
    });
  }
}

async function readReportJson(
  store: FsArtifactStore,
  run: { id: string; dir: string },
  runId: string
): Promise<ReportJson> {
  const raw = await readReportFile(store.pathFor(run, "report.json"), runId);
  return JSON.parse(raw) as ReportJson;
}
