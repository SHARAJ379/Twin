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

  // Informational, never a failure: nothing Twin runs uses git. It's only
  // what installing Twin from source (`git clone`) needs.
  const git = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
  checks.push({
    name: "git",
    ok: true,
    detail: git.status === 0 ? git.stdout.trim() : "not found - only needed to install Twin from source"
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
