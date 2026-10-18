import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, "../../scripts/readmeInstall.mjs");

function extract(route: string, shell: string, readme?: string): { code: number | null; stdout: string; stderr: string } {
  const args = [script, route, shell, ...(readme !== undefined ? ["--readme", readme] : [])];
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const block = (marker: string, lines: string[]): string =>
  ["# Install", "", `<!-- install-check: ${marker} -->`, "```bash", ...lines, "```", ""].join("\n");

/**
 * The README's install line once failed on every OS - `npm install -g
 * github:SHARAJ379/Twin` can't build a git package globally - and no CI job
 * ran it. The install workflow runs whatever these blocks say; these tests
 * keep the blocks themselves runnable, on every push.
 */
describe("scripts/readmeInstall.mjs", () => {
  let dir: string;

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function readmeWith(content: string): Promise<string> {
    dir = await mkdtemp(path.join(os.tmpdir(), "readme-install-"));
    const file = path.join(dir, "README.md");
    await writeFile(file, content, "utf8");
    return file;
  }

  it.each([
    ["npx", "posix"],
    ["npx", "powershell"],
    ["clone", "posix"],
    ["clone", "powershell"]
  ])("finds the real README's %s block for %s, ending in doctor and then --version", (route, shell) => {
    const { code, stdout, stderr } = extract(route, shell);
    expect(code, stderr).toBe(0);
    const lines = stdout.split(/\r?\n/).filter((line) => !line.startsWith("Write-Host") && !line.startsWith("if (") && line.trim() !== "");
    expect(lines.some((line) => / doctor$/.test(line))).toBe(true);
    expect(lines.at(-1)).toMatch(/ --version$/);
  });

  it("refuses the global git install that shipped broken", async () => {
    const readme = await readmeWith(block("clone posix", ["npm install -g github:SHARAJ379/Twin", "twin doctor"]));
    const { code, stderr } = extract("clone", "posix", readme);
    expect(code).toBe(1);
    expect(stderr).toContain("can't build a git package in a global install");
  });

  it("refuses npx on a git package without --allow-git, which npm 12 rejects", async () => {
    const readme = await readmeWith(block("npx posix", ["npx github:SHARAJ379/Twin doctor"]));
    const { code, stderr } = extract("npx", "posix", readme);
    expect(code).toBe(1);
    expect(stderr).toContain("--allow-git");
  });

  it("fails when the block is gone, or doesn't end by running doctor", async () => {
    expect(extract("clone", "posix", await readmeWith("# Install\n\nnpm install -g twin\n")).code).toBe(1);
    const noDoctor = await readmeWith(block("clone posix", ["npm install -g ."]));
    const { code, stderr } = extract("clone", "posix", noDoctor);
    expect(code).toBe(1);
    expect(stderr).toContain("doctor");
  });

  /**
   * The generated script must stop at the first command that fails - a
   * script that ran on and finished with a passing `doctor` would turn a
   * broken install line into a green job. Each OS checks the shell its
   * README block is for (the install workflow runs posix on Linux and
   * PowerShell on Windows).
   */
  it("generates a script that stops at the first failing command", async () => {
    const shell = process.platform === "win32" ? "powershell" : "posix";
    // Shell-native commands, not `node -e`: under `npx -p node@20` the `node`
    // on PATH is the npm "node" package's PowerShell shim, which reports exit
    // 0 whatever node returned - that would test the shim, not this script.
    // (npm's own shims, and the `twin` shim npm generates, do pass exit codes on.)
    // And `cmd.exe`, not `cmd`: CI's Ruby setup puts MSYS2's usr\bin on PATH,
    // whose extensionless `cmd` PowerShell finds first and merely opens -
    // nothing runs, and no exit code is set.
    const commands =
      shell === "posix"
        ? ["false", "touch ran-after-failure", "echo doctor"]
        : ["cmd.exe /c exit 3", "New-Item -ItemType File ran-after-failure", "cmd.exe /c echo doctor"];
    const readme = await readmeWith([`<!-- install-check: clone ${shell} -->`, "```", ...commands, "```"].join("\n"));
    const generated = extract("clone", shell, readme);
    expect(generated.code, generated.stderr).toBe(0);
    const scriptFile = path.join(dir, shell === "posix" ? "install.sh" : "install.ps1");
    await writeFile(scriptFile, generated.stdout, "utf8");

    const run =
      shell === "posix"
        ? spawnSync("bash", [scriptFile], { cwd: dir, encoding: "utf8" })
        : spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptFile], { cwd: dir, encoding: "utf8" });

    expect(run.status).not.toBe(0);
    expect(existsSync(path.join(dir, "ran-after-failure"))).toBe(false);
  });
});
