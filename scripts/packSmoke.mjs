#!/usr/bin/env node
/**
 * Packs Twin, installs the tarball into a throwaway project, and drives the
 * installed binary.
 *
 * A green test suite says nothing about publishability: it runs against the
 * working tree, with devDependencies present and every file available. The
 * last pre-publish audit found two bugs that only this shape of check can
 * see - `npm run build` not cleaning dist/, so files from deleted sources
 * shipped, and a `prepublishOnly` that hard-failed without all five language
 * toolchains - and both were found by hand. This is that check, automated.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));

let failures = 0;

function check(ok, description, detail) {
  if (ok) {
    console.log(`  ok   ${description}`);
    return true;
  }
  failures++;
  console.log(`  FAIL ${description}`);
  if (detail !== undefined) console.log(`       ${String(detail).split("\n").join("\n       ")}`);
  return false;
}

function settle(result) {
  if (result.error !== undefined && result.error !== null) {
    return { code: null, stdout: "", stderr: String(result.error.message) };
  }
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** spawnSync, never throwing: several of these checks are about a non-zero exit code. */
function run(command, args, options = {}) {
  return settle(spawnSync(command, args, { encoding: "utf8", shell: false, ...options }));
}

/**
 * npm is a .cmd shim on Windows, which Node refuses to spawn without a shell
 * (EINVAL since 20.12). Going through the shell means quoting by hand - every
 * path here can contain a space, starting with the user's home directory.
 */
function npmRun(args, cwd) {
  const quoted = args.map((arg) => (/[\s"]/.test(arg) ? `"${arg}"` : arg));
  const command = [npm, ...quoted].join(" ");
  const result = settle(spawnSync(command, { encoding: "utf8", shell: true, cwd }));
  if (result.code !== 0) {
    console.error(`\n${command} failed (exit ${String(result.code)})`);
    console.error(result.stdout);
    console.error(result.stderr);
    process.exit(1);
  }
  return result;
}

const workDir = mkdtempSync(path.join(os.tmpdir(), "twin-pack-smoke-"));

try {
  // A fresh build, because a stale dist/ is exactly one of the bugs this guards.
  console.log("building...");
  npmRun(["run", "build"], repoRoot);

  console.log("packing...");
  const packed = npmRun(["pack", "--json", "--pack-destination", workDir], repoRoot);
  const [manifest] = JSON.parse(packed.stdout);
  const tarball = path.join(workDir, manifest.filename);

  console.log("\ntarball contents");
  const shipped = manifest.files.map((entry) => entry.path.split(path.sep).join("/"));
  check(shipped.includes("dist/cli/index.js"), "ships the CLI entrypoint named by package.json's bin");
  check(
    shipped.every((file) => file.startsWith("dist/") || ["README.md", "LICENSE", "package.json"].includes(file)),
    "ships nothing outside dist/ + README/LICENSE",
    shipped.filter((file) => !file.startsWith("dist/") && !["README.md", "LICENSE", "package.json"].includes(file)).join("\n")
  );
  check(
    !shipped.some((file) => file.includes(".test.") || file.startsWith("src/") || file.startsWith("examples/")),
    "ships no tests, sources, or example fixtures"
  );
  const maps = shipped.filter((file) => file.endsWith(".js.map"));
  const mapsMissingSource = maps.filter((file) => {
    const parsed = JSON.parse(readFileSync(path.join(repoRoot, file), "utf8"));
    return !Array.isArray(parsed.sourcesContent) || parsed.sourcesContent.some((source) => !source);
  });
  check(
    maps.length > 0 && mapsMissingSource.length === 0,
    "every shipped source map embeds its source, since the .ts files aren't in the tarball",
    mapsMissingSource.join("\n")
  );

  console.log("\ninstalling the tarball into a clean project");
  const consumer = path.join(workDir, "consumer");
  await mkdir(consumer, { recursive: true });
  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "twin-pack-smoke", version: "0.0.0", private: true }, null, 2)
  );
  npmRun(["install", tarball, "--no-audit", "--no-fund", "--loglevel=error"], consumer);

  const installedDir = path.join(consumer, "node_modules", pkg.name);
  const cli = path.join(installedDir, "dist", "cli", "index.js");
  check(existsSync(cli), "the installed package has its binary where bin points");
  check(
    readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node"),
    "the binary keeps its shebang, so the PATH shim can exec it"
  );
  const shim = path.join(consumer, "node_modules", ".bin", process.platform === "win32" ? "twin.cmd" : "twin");
  check(existsSync(shim), "npm created the `twin` shim on PATH");

  console.log("\ndriving the installed binary");
  const version = run(process.execPath, [cli, "--version"]);
  check(version.code === 0 && version.stdout.trim() === pkg.version, `--version prints ${pkg.version}`, version.stderr);

  const help = run(process.execPath, [cli, "--help"]);
  check(
    help.code === 0 && ["run", "report", "init", "doctor", "clean"].every((cmd) => help.stdout.includes(cmd)),
    "--help lists every command"
  );

  const doctor = run(process.execPath, [cli, "doctor"]);
  check(doctor.code === 0, "doctor reports this machine can run Twin", doctor.stdout + doctor.stderr);

  // Proves the whole runtime module graph resolves from the installed package -
  // commander, yaml, ajv and dotenv included. A dependency left in
  // devDependencies by mistake fails right here, and nowhere in the test suite.
  const emptyProject = path.join(workDir, "empty-project");
  await mkdir(emptyProject, { recursive: true });
  const noScenario = run(process.execPath, [cli, "run", "--project", emptyProject]);
  check(
    noScenario.code === 2 && `${noScenario.stdout}${noScenario.stderr}`.includes("no scenario given"),
    "run without a scenario exits 2 with its own error, not a crash",
    `exit ${String(noScenario.code)}\n${noScenario.stdout}${noScenario.stderr}`
  );

  const initProject = path.join(workDir, "init-project");
  await mkdir(initProject, { recursive: true });
  writeFileSync(
    path.join(initProject, "package.json"),
    JSON.stringify({ name: "app", version: "1.0.0", scripts: { start: "node server.js" } }, null, 2)
  );
  const init = run(process.execPath, [cli, "init", "--project", initProject]);
  check(
    init.code === 0 &&
      existsSync(path.join(initProject, "scenario.yaml")) &&
      existsSync(path.join(initProject, "twin.config.json")),
    "init scaffolds a scenario and a config",
    init.stdout + init.stderr
  );
} finally {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(failures === 0 ? "\npack smoke test passed" : `\npack smoke test failed: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
