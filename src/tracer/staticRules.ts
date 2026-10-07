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
// Map/Set are as common as {} and [] for this in modern code, so they belong
// in the same rule - the failure mode is identical.
const MODULE_STATE_PATTERN =
  /^(const|let|var)\s+\w+\s*=\s*(\{\}|\[\]|new\s+(Map|Set|WeakMap|WeakSet)\s*\(.*\)|Object\.create\(\s*null\s*\))\s*;?\s*(\/\/.*)?$/;

export const moduleStateRule: SuspectRule = {
  id: "module-level-empty-container",
  kind: "module-state",
  confidence: "medium",
  rationale:
    "a top-level object/array/Map initialized once and mutated by request handlers lives in this process's memory only - a second instance, or this one after a restart, starts with an empty one",
  test: (line) => MODULE_STATE_PATTERN.test(line),
  fixtures: {
    matches: [
      "const sessions = {};",
      "let items = [];",
      "var cache = {}",
      "const items = []; // { id, name }",
      "const notes = new Map();",
      "let seen = new Set();",
      'const cache = new Map([["a", 1]]);',
      "const registry = Object.create(null);"
    ],
    nonMatches: [
      "  const sessions = {};",
      "  const notes = new Map();",
      "const CONFIG = { port: 3000 };",
      "const items = getItems();"
    ]
  }
};

// Only `let`/`var`: a mutable module-level number is a counter, and two
// instances each start it from the same value and hand out colliding ids.
const MODULE_COUNTER_PATTERN = /^(let|var)\s+\w+\s*=\s*-?\d+\s*;?\s*(\/\/.*)?$/;

export const moduleCounterRule: SuspectRule = {
  id: "module-level-counter",
  kind: "module-state",
  confidence: "low",
  rationale:
    "a top-level mutable counter (next id, sequence number) restarts from its initial value in every process - two instances hand out the same ids, so records collide or overwrite each other",
  test: (line) => MODULE_COUNTER_PATTERN.test(line),
  fixtures: {
    matches: ["let nextId = 1;", "var counter = 0", "let nextNoteId = 1; // ids start at 1"],
    nonMatches: ["const PORT = 3000;", "  let i = 0;", 'let name = "x";', "let total = items.length;"]
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
  moduleCounterRule,
  expressSessionNoStoreRule,
  fsWriteRelativePathRule,
  sqliteFileRule
];
