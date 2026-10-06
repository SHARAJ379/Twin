import type { SuspectKind } from "../domain/suspect.js";

export interface SuspectRuleFixtures {
  /** Snippets that must produce at least one match - proof the rule actually fires. */
  matches: string[];
  /** Snippets that must produce zero matches - proof the rule isn't trigger-happy. */
  nonMatches: string[];
}

export interface SuspectRule {
  id: string;
  kind: SuspectKind;
  /** Static rules are capped below "high" (§6.5) - only a workspace-diff match earns that. */
  confidence: "medium" | "low";
  rationale: string;
  /** `line` is one source line; `fullFileContent` lets a rule look for cross-line context (e.g. "is there a store: anywhere in this file"). */
  test: (line: string, fullFileContent: string) => boolean;
  fixtures: SuspectRuleFixtures;
}

// Trailing line comments ("const items = []; // { id, name }") are common
// enough in real code that the pattern has to tolerate them explicitly.
const MODULE_STATE_PATTERN = /^(const|let|var)\s+\w+\s*=\s*(\{\}|\[\])\s*;?\s*(\/\/.*)?$/;

export const moduleStateRule: SuspectRule = {
  id: "module-level-empty-container",
  kind: "module-state",
  confidence: "medium",
  rationale:
    "a top-level object/array initialized once and mutated by request handlers lives in this process's memory only - a second instance, or this one after a restart, starts with an empty one",
  test: (line) => MODULE_STATE_PATTERN.test(line),
  fixtures: {
    matches: ["const sessions = {};", "let items = [];", "var cache = {}", "const items = []; // { id, name }"],
    nonMatches: ["  const sessions = {};", "const CONFIG = { port: 3000 };", "const items = getItems();"]
  }
};

const SESSION_IMPORT_PATTERN = /require\(\s*["']express-session["']\s*\)|from\s+["']express-session["']/;

export const expressSessionNoStoreRule: SuspectRule = {
  id: "express-session-no-store",
  kind: "memory-session-store",
  confidence: "medium",
  rationale:
    "express-session defaults to an in-memory MemoryStore when no `store` is configured - sessions don't survive a restart and aren't shared across instances",
  test: (line, fullFileContent) => SESSION_IMPORT_PATTERN.test(line) && !fullFileContent.includes("store:"),
  fixtures: {
    matches: ['const session = require("express-session");\napp.use(session({ secret: "x" }));'],
    nonMatches: [
      'const session = require("express-session");\napp.use(session({ secret: "x", store: new RedisStore() }));'
    ]
  }
};

const FS_WRITE_PATTERN = /fs\.(writeFile(Sync)?|createWriteStream)\s*\(/;

export const fsWriteRelativePathRule: SuspectRule = {
  id: "fs-write-not-env-configured",
  kind: "local-fs-write",
  confidence: "medium",
  rationale:
    "a file written to a path that isn't configured via an env var lands on this instance's own local disk - another instance (or a managed host's ephemeral filesystem after a restart) won't see it",
  test: (line) => FS_WRITE_PATTERN.test(line) && !line.includes("process.env"),
  fixtures: {
    matches: ['fs.writeFileSync(path.join(__dirname, "data.json"), body);'],
    nonMatches: ["fs.writeFileSync(process.env.DATA_FILE, body);"]
  }
};

const SQLITE_PATTERN = /require\(\s*["'](better-)?sqlite3["']\s*\)|new\s+Database\s*\(/;

export const sqliteFileRule: SuspectRule = {
  id: "sqlite-file-path",
  kind: "sqlite-file",
  confidence: "medium",
  rationale: "a SQLite file lives on one instance's local disk - another instance has its own separate (and likely empty) copy",
  test: (line) => SQLITE_PATTERN.test(line) && !line.includes(":memory:"),
  fixtures: {
    matches: ['const db = new Database("app.db");', 'const sqlite3 = require("better-sqlite3");'],
    nonMatches: ['const db = new Database(":memory:");']
  }
};

/** Every static rule. New rules must ship with both fixture kinds - enforced by staticRules.test.ts. */
export const staticRules: SuspectRule[] = [
  moduleStateRule,
  expressSessionNoStoreRule,
  fsWriteRelativePathRule,
  sqliteFileRule
];
