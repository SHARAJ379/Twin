#!/usr/bin/env node
/**
 * Turns one of the README's install blocks into a script CI can run, so the
 * install job runs exactly what users copy - and fails the moment that stops
 * working.
 *
 *   node scripts/readmeInstall.mjs <route> <shell> [--readme <path>]
 *
 * A block is the fenced code block right after a marker comment in README.md:
 *
 *   <!-- install-check: clone posix -->
 *   <!-- install-check: npx posix powershell -->
 *
 * The block must end by running `<twin invocation> doctor`; the script adds
 * `<twin invocation> --version` after it, so every route proves both.
 *
 * Why it exists: the README once said `npm install -g github:SHARAJ379/Twin`,
 * which fails on every OS (npm builds a git package in an install that, with
 * -g, never gets its devDependencies), and nothing ran that line. The pack
 * smoke test installs a tarball and the Action builds from a checkout.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHELLS = new Set(["posix", "powershell"]);

/**
 * Lines that can never work, with why. `-g` and a git package: npm runs the
 * package's build in an install that inherits the global flag, so its
 * devDependencies (tsc, @types/node) are never there.
 */
const KNOWN_BROKEN = [
  {
    pattern: /\bnpm\s+(?:install|i|add)\b(?=.*\s(?:-g|--global)\b)(?=.*\s(?:github:|git\+|git:\/\/|https:\/\/github\.com\/))/,
    why: "npm can't build a git package in a global install (its devDependencies never land), so this fails on every OS"
  },
  {
    pattern: /\bnpx\b(?!.*--allow-git)(?=.*\s(?:github:|git\+|git:\/\/))/,
    why: "npm 12 refuses to fetch git packages unless --allow-git is given"
  }
];

/** The commands in the README's block for this route and shell, without blank and comment-only lines. */
export function installCommands(readme, route, shell) {
  if (!SHELLS.has(shell)) throw new Error(`unknown shell "${shell}" - expected one of: ${[...SHELLS].join(", ")}`);
  const lines = readme.replace(/\r\n/g, "\n").split("\n");
  const markerAt = lines.findIndex((line) => {
    const match = /^<!--\s*install-check:\s*([^>]*?)\s*-->\s*$/.exec(line.trim());
    if (match === null) return false;
    const [markerRoute, ...shells] = match[1].split(/\s+/);
    return markerRoute === route && shells.includes(shell);
  });
  if (markerAt === -1) {
    throw new Error(`README.md has no "<!-- install-check: ${route} ... ${shell} -->" block - did its install section change?`);
  }

  const open = lines.findIndex((line, index) => index > markerAt && line.trim().startsWith("```"));
  const between = lines.slice(markerAt + 1, open === -1 ? markerAt + 1 : open);
  if (open === -1 || between.some((line) => line.trim().length > 0)) {
    throw new Error(`the "install-check: ${route}" marker must be followed directly by a fenced code block`);
  }
  const close = lines.findIndex((line, index) => index > open && line.trim().startsWith("```"));
  if (close === -1) throw new Error(`the "install-check: ${route}" code block is never closed`);

  const commands = lines
    .slice(open + 1, close)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (commands.length === 0) throw new Error(`the "install-check: ${route}" code block is empty`);

  for (const command of commands) {
    for (const { pattern, why } of KNOWN_BROKEN) {
      if (pattern.test(command)) throw new Error(`README install command "${command}" can't work: ${why}`);
    }
  }

  const last = commands.at(-1).replace(/\s+#.*$/, "");
  if (!/\sdoctor$/.test(last) && last !== "doctor") {
    throw new Error(`the "install-check: ${route}" block must end by running \`<twin> doctor\`, so CI can check the result - it ends with "${last}"`);
  }
  return { commands, twin: last.replace(/\s+doctor$/, "") };
}

/** A script that runs the commands in order, stopping at the first that fails, then checks `--version`. */
export function renderScript(route, shell, { commands, twin }) {
  const all = [...commands, `${twin} --version`];
  if (shell === "posix") {
    return ["# Generated from README.md by scripts/readmeInstall.mjs - do not edit.", "set -euxo pipefail", ...all, ""].join("\n");
  }
  // Windows PowerShell 5.1 never stops on a native command's exit code, so
  // each one is checked. 'Stop' makes a failing cmdlet (`cd` into a missing
  // folder) end the script too; native stderr output doesn't trip it.
  const quote = (text) => `'${text.replace(/'/g, "''")}'`;
  const body = all.flatMap((command) => [
    `Write-Host ${quote(`> ${command}`)}`,
    "$global:LASTEXITCODE = 0",
    command,
    `if ($LASTEXITCODE -ne 0) { Write-Host ${quote(`README install command failed: ${command}`)} "(exit $LASTEXITCODE)"; exit 1 }`
  ]);
  return ["# Generated from README.md by scripts/readmeInstall.mjs - do not edit.", "$ErrorActionPreference = 'Stop'", ...body, ""].join(
    "\r\n"
  );
}

function main(argv) {
  const args = [...argv];
  const readmeFlag = args.indexOf("--readme");
  const readmePath =
    readmeFlag === -1
      ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "README.md")
      : path.resolve(args.splice(readmeFlag, 2)[1]);
  const [route, shell] = args;
  if (route === undefined || shell === undefined) {
    console.error("usage: node scripts/readmeInstall.mjs <route> <posix|powershell> [--readme <path>]");
    return 2;
  }
  try {
    const extracted = installCommands(readFileSync(readmePath, "utf8"), route, shell);
    process.stdout.write(renderScript(route, shell, extracted));
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

// By name, not by comparing URLs: on Windows the same file can be reached
// through a short 8.3 path, and a guard that quietly never matched would
// print nothing - which a CI step would then run as an empty script.
if (process.argv[1] !== undefined && path.basename(process.argv[1]) === "readmeInstall.mjs") {
  process.exit(main(process.argv.slice(2)));
}
