import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LOOPBACK_HOST } from "../../src/domain/loopbackHost.js";
import { detectStack } from "../../src/infra/stack/detectStack.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const examplesDir = path.resolve(here, "../../examples");

/** One place an app decides what address it listens on, and the host it names ("" for every interface). */
interface BindSite {
  where: string;
  text: string;
  host: string;
}

const unquote = (text: string): string => text.trim().replace(/^["'](.*)["']$/, "$1");
const isStringLiteral = (text: string): boolean => /^["'][^"']*["']$/.test(text.trim());

/**
 * Listen calls, per language, and how each names its host. A call with no
 * host at all listens on every interface: Node's `listen(port)`, Go's
 * `ListenAndServe(":"+port)`, Ruby's `TCPServer.new(port)`.
 */
const SOURCE_BINDS: Array<{ extensions: string[]; pattern: RegExp; host: (match: RegExpExecArray) => string }> = [
  {
    extensions: [".js", ".mjs", ".cjs", ".ts"],
    pattern: /\.listen\(([^)]*)\)/g,
    host: (m) => {
      const second = m[1]!.split(",")[1];
      return second !== undefined && isStringLiteral(second) ? unquote(second) : "";
    }
  },
  {
    extensions: [".go"],
    pattern: /\b(?:ListenAndServe(?:TLS)?\(\s*|net\.Listen\(\s*"tcp[46]?"\s*,\s*)([^,)]+)/g,
    host: (m) => /^"([^":]*):/.exec(m[1]!.trim())?.[1] ?? ""
  },
  {
    extensions: [".py"],
    pattern: /(?:\b\w*Server\(\s*\(|\.bind\(\s*\()\s*([^,]+),|\.run\([^)]*\bhost\s*=\s*([^,)]+)/g,
    host: (m) => unquote(m[1] ?? m[2]!)
  },
  {
    extensions: [".rb"],
    pattern: /TCPServer\.new\(([^)]*)\)|BindAddress:\s*([^,}\s]+)|set\s+:bind\s*,\s*(\S+)/g,
    host: (m) => {
      if (m[1] !== undefined) {
        const args = m[1].split(",");
        return args.length >= 2 ? unquote(args[0]!) : "";
      }
      return unquote(m[2] ?? m[3]!);
    }
  }
];

/** Hosts named in a start command (`php -S 127.0.0.1:{{port}}`, `--host 127.0.0.1`, `-b`, `-o`, `runserver host:port`). */
const START_COMMAND_HOST = /(?:-S\s+|runserver\s+)([^\s:]+):|(?:--host[=\s]+|\s-[bo]\s+)([^\s:]+)/g;

async function sourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "vendor") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
    else files.push(full);
  }
  return files;
}

async function bindSites(exampleDir: string): Promise<BindSite[]> {
  const sites: BindSite[] = [];
  for (const file of await sourceFiles(exampleDir)) {
    const rules = SOURCE_BINDS.filter((rule) => rule.extensions.includes(path.extname(file)));
    if (rules.length === 0) continue;
    const text = await readFile(file, "utf8");
    for (const rule of rules) {
      for (const match of text.matchAll(rule.pattern)) {
        sites.push({ where: path.relative(exampleDir, file), text: match[0], host: rule.host(match) });
      }
    }
  }
  const { startCommand } = await detectStack(exampleDir);
  for (const match of (startCommand ?? "").matchAll(START_COMMAND_HOST)) {
    sites.push({ where: "its start command", text: startCommand!, host: match[1] ?? match[2]! });
  }
  return sites;
}

/**
 * Twin only ever connects to an instance over 127.0.0.1. An example that
 * listens on every interface gains nothing from it, and on Windows it's what
 * brought up "allow public and private networks to access this app?" - once
 * per instance, every run, for the Go examples, which `go run` relinked into a
 * new temp folder each time.
 */
const examples = (await readdir(examplesDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);

describe("every example listens on 127.0.0.1 only", () => {
  it("finds every example", () => {
    expect(examples.length).toBeGreaterThanOrEqual(10);
  });

  it.each(examples)("%s", async (example) => {
    const sites = await bindSites(path.join(examplesDir, example));
    // Finding nothing would pass vacuously: an example has to say where it listens.
    expect(sites, `found no listen call in examples/${example} - teach this test its server's API`).not.toHaveLength(0);
    const wide = sites.filter((site) => site.host !== LOOPBACK_HOST);
    expect(wide, `listens on more than this machine:\n${wide.map((s) => `  ${s.where}: ${s.text}`).join("\n")}`).toEqual([]);
  });
});
