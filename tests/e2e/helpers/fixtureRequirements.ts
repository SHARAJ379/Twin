import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Whether the probe command runs at all - i.e. that language runtime is installed here. */
function canRun(probeCommand: string): boolean {
  // One command string rather than (command, args) because Node deprecates the
  // args form under `shell: true` (DEP0190). shell: true is what lets Windows
  // resolve .cmd/.bat shims and app-execution aliases via PATHEXT; every caller
  // passes a string literal, so nothing untrusted reaches the shell.
  const result = spawnSync(probeCommand, { stdio: "ignore", shell: true, timeout: 20_000 });
  return result.status === 0;
}

/**
 * Guards an e2e suite that boots a real fixture app in another language.
 *
 * Locally, a missing runtime skips the suite rather than failing it with a
 * confusing `E_BOOT_CRASH` 90 seconds later - you shouldn't need all five
 * toolchains installed to work on, say, the report formatter.
 *
 * In CI it throws instead. CI installs every toolchain on purpose, so a
 * missing one there means the workflow is misconfigured - and silently
 * skipping would turn that into a green run that verified nothing, which is
 * exactly the failure mode Twin itself exists to catch.
 */
export function runtimeMissing(label: string, probeCommand: string): boolean {
  if (canRun(probeCommand)) return false;
  if (process.env.CI !== undefined && process.env.CI !== "") {
    throw new Error(
      `${label} is not installed, but CI is expected to run the live ${label} fixture tests. ` +
        `Skipping them would be a false green - fix the ${label} setup step in .github/workflows/ci.yml.`
    );
  }
  console.warn(`[skip] ${label} is not installed - skipping the live ${label} fixture e2e tests`);
  return true;
}

/**
 * Same contract as `runtimeMissing`, for the Node fixture apps: they're
 * standalone packages, so on a fresh clone they have no node_modules until
 * `npm ci --prefix examples/<app>` has been run.
 */
export function fixtureDepsMissing(...fixtureDirs: string[]): boolean {
  const missing = fixtureDirs.filter((dir) => !existsSync(`${dir}/node_modules`));
  if (missing.length === 0) return false;
  if (process.env.CI !== undefined && process.env.CI !== "") {
    throw new Error(
      `Fixture app dependencies are not installed (${missing.join(", ")}), but CI installs them on purpose. ` +
        `Skipping these tests would be a false green - fix the \`npm ci --prefix\` steps in .github/workflows/ci.yml.`
    );
  }
  console.warn(
    `[skip] fixture app dependencies missing - run \`npm ci --prefix <dir>\` for: ${missing.join(", ")}`
  );
  return true;
}
