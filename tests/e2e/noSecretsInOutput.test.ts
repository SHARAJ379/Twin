import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(REPO, "src", "cli", "index.ts");

// One secret per way a user hands Twin one. The commands carry theirs as a
// `--token=`-style argument, the env ones under a secret-sounding name.
const SECRETS = {
  start: "StartTok3nSecret1",
  build: "BuildTok3nSecret2",
  setup: "SetupPassw0rdSecret3",
  configEnv: "ConfigApiK3ySecret4",
  envFlag: "EnvFlagPassw0rd5"
};

// Prints everything it was given - argv and the secret env - at boot, the
// way an app logging its config does, so each copy's log holds them all.
const APP = `
const http = require("node:http");
console.log("booting", process.argv.join(" "), process.env.API_KEY, process.env.DB_PASSWORD);
http.createServer((req, res) => {
  res.writeHead(req.url === "/health" || req.url === "/ping" ? 200 : 404, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

const ECHO = `console.log("ran", process.argv.join(" "), process.env.API_KEY, process.env.DB_PASSWORD);\n`;

const SCENARIO = `name: secrets
version: 1
steps:
  - id: ping-a
    kind: request
    via: A
    request: { method: GET, path: /ping }
    expect: { status: 200 }
  - id: ping-b
    kind: request
    via: B
    request: { method: GET, path: /ping }
    expect: { status: 200 }
    check: data-consistency
`;

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
}

function twin(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
      cwd: REPO,
      env: { ...process.env, NO_COLOR: "1", TWIN_DEBUG: "1" },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Security audit, second pass: a secret written into a command was masked in
 * the setup line and the errors, but not on the "stack:" line every run
 * prints - so it went to CI logs on every run. This runs the real CLI with a
 * secret in every place a user can put one and looks for each anywhere Twin
 * writes: its own stdout and stderr, and every file under .twin/.
 */
describe("secrets the user hands Twin", () => {
  let projectDir: string;

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function project(): Promise<void> {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "secrets-fixture-"));
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "secrets-fixture", private: true }), "utf8");
    await writeFile(path.join(projectDir, "server.js"), APP, "utf8");
    await writeFile(path.join(projectDir, "build.js"), ECHO, "utf8");
    await writeFile(path.join(projectDir, "setup.js"), ECHO, "utf8");
    await writeFile(path.join(projectDir, "scenario.yaml"), SCENARIO, "utf8");
    await writeFile(
      path.join(projectDir, "twin.config.json"),
      JSON.stringify({
        scenario: "scenario.yaml",
        setup: `node setup.js --password=${SECRETS.setup}`,
        env: { API_KEY: SECRETS.configEnv }
      }),
      "utf8"
    );
  }

  async function expectNoSecretAnywhere(result: { stdout: string; stderr: string }): Promise<void> {
    const files = await filesUnder(path.join(projectDir, ".twin"));
    expect(files.some((file) => file.endsWith(".log"))).toBe(true);
    const places = [
      { name: "stdout", text: result.stdout },
      { name: "stderr", text: result.stderr },
      ...(await Promise.all(files.map(async (file) => ({ name: path.relative(projectDir, file), text: await readFile(file, "utf8") }))))
    ];
    const leaks = places.flatMap(({ name, text }) =>
      Object.entries(SECRETS)
        .filter(([, secret]) => text.includes(secret))
        .map(([from]) => `${from} secret in ${name}`)
    );
    expect(leaks).toEqual([]);
  }

  it("shows none of them in a run that completes", async () => {
    await project();

    const result = await twin(
      [
        "run",
        "--project", projectDir,
        "--start", `node server.js --token=${SECRETS.start}`,
        "--build", `node build.js --token=${SECRETS.build}`,
        "--env", `DB_PASSWORD=${SECRETS.envFlag}`
      ]
    );

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("stack:");
    await expectNoSecretAnywhere(result);
  }, 120_000);

  it("shows none of them when the app fails to boot", async () => {
    await project();

    const result = await twin(
      [
        "run",
        "--project", projectDir,
        "--start", `node nothere.js --token=${SECRETS.start}`,
        "--build", `node build.js --token=${SECRETS.build}`,
        "--env", `DB_PASSWORD=${SECRETS.envFlag}`
      ]
    );

    expect(result.code, result.stdout + result.stderr).not.toBe(0);
    expect(result.stderr).toContain("E_BOOT");
    await expectNoSecretAnywhere(result);
  }, 120_000);
});
