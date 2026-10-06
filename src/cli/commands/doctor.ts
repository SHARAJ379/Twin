import { spawnSync } from "node:child_process";
import os from "node:os";

import type { Logger } from "../../ports/logger.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export function runDoctorChecks(): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "Node.js >= 20",
    ok: Number.isFinite(major) && major >= 20,
    detail: `node ${process.versions.node}`
  });

  checks.push({
    name: "Platform",
    ok: true,
    detail: `${os.platform()} ${os.arch()}`
  });

  const git = spawnSync("git", ["--version"], { encoding: "utf8" });
  checks.push({
    name: "git available",
    ok: git.status === 0,
    detail: git.status === 0 ? git.stdout.trim() : "not found (only needed for `twin init` on a fresh repo)"
  });

  return checks;
}

/** Prints each check and returns whether every one passed. */
export function printDoctorReport(checks: DoctorCheck[], logger: Logger): boolean {
  let allOk = true;
  for (const check of checks) {
    if (check.ok) {
      logger.info(`✓ ${check.name}`, { detail: check.detail });
    } else {
      allOk = false;
      logger.error(`✗ ${check.name}`, { detail: check.detail });
    }
  }
  return allOk;
}
