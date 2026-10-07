import type { StackDetectionInput, StackProfile } from "../stack.js";
import type { SuspectRule } from "../suspectRule.js";

// Package-level `var` at column 0. Composite literals and make() both count:
// the container is created once per process either way.
const PACKAGE_STATE_PATTERN =
  /^var\s+\w+\s*(=\s*(make\s*\(\s*(map|\[\])|map\[[^\]]+\][\w*.[\]]+\{|\[\][\w*.]+\{)|\s+(map\[[^\]]+\][\w*.[\]]+|\[\][\w*.]+)\s*$)/;

export const packageStateRule: SuspectRule = {
  id: "go-package-level-container",
  kind: "module-state",
  confidence: "medium",
  rationale:
    "a package-level map/slice mutated by handlers lives in this process's memory only - another instance, or this one after a restart, starts with an empty one",
  test: (line) => PACKAGE_STATE_PATTERN.test(line),
  fixtures: {
    matches: [
      "var sessions = make(map[string]Session)",
      "var items []Item",
      "var cache = map[string]string{}",
      "var notes = make(map[string]*Note)",
      "var users = []User{}"
    ],
    nonMatches: ["\tvar sessions = make(map[string]Session)", "var port = 8080", "var db *sql.DB", "func main() {"]
  }
};

const PACKAGE_COUNTER_PATTERN = /^var\s+\w+\s*(int\d*|uint\d*)?\s*=\s*-?\d+\s*$/;

export const packageCounterRule: SuspectRule = {
  id: "go-package-level-counter",
  kind: "module-state",
  confidence: "low",
  rationale:
    "a package-level counter restarts from its initial value in every process - two instances hand out the same ids, so records collide or overwrite each other",
  test: (line) => PACKAGE_COUNTER_PATTERN.test(line),
  fixtures: {
    matches: ["var nextID = 1", "var counter int = 0", "var seq int64 = 0"],
    nonMatches: ["\tvar nextID = 1", 'var addr = ":8080"', "var items []Item"]
  }
};

// A key generated at startup differs per process, so cookies signed by one
// instance fail authentication on the other.
const RANDOM_KEY_PATTERN =
  /(securecookie\.GenerateRandomKey|rand\.Read)\s*\(|sessions\.NewCookieStore\s*\(\s*(securecookie\.GenerateRandomKey|\[\]byte\s*\(\s*uuid)/;

export const randomSessionKeyRule: SuspectRule = {
  id: "go-random-session-key",
  kind: "memory-session-store",
  confidence: "medium",
  rationale:
    "a session key generated at startup is different in every process, so a cookie signed by one instance fails validation on another - read the key from a shared env var instead",
  test: (line) => RANDOM_KEY_PATTERN.test(line),
  fixtures: {
    matches: [
      "var store = sessions.NewCookieStore(securecookie.GenerateRandomKey(32))",
      "key := securecookie.GenerateRandomKey(64)"
    ],
    nonMatches: ['var store = sessions.NewCookieStore([]byte(os.Getenv("SESSION_KEY")))']
  }
};

const FS_SESSION_PATTERN = /sessions\.NewFilesystemStore\s*\(/;

export const filesystemSessionStoreRule: SuspectRule = {
  id: "go-filesystem-session-store",
  kind: "memory-session-store",
  confidence: "medium",
  rationale: "a filesystem session store writes to this instance's own disk - the other instance can't read those sessions",
  test: (line) => FS_SESSION_PATTERN.test(line),
  fixtures: {
    matches: ['var store = sessions.NewFilesystemStore("", []byte(key))'],
    nonMatches: ["var store = redistore.NewRediStore(10, \"tcp\", \":6379\", \"\", []byte(key))"]
  }
};

const SQLITE_PATTERN = /sql\.Open\s*\(\s*["']sqlite3?["']|mattn\/go-sqlite3|modernc\.org\/sqlite/;

export const sqliteFileRule: SuspectRule = {
  id: "go-sqlite-file",
  kind: "sqlite-file",
  confidence: "medium",
  rationale: "a SQLite file lives on one instance's local disk - another instance has its own separate (and likely empty) copy",
  test: (line) => SQLITE_PATTERN.test(line) && !line.includes(":memory:"),
  fixtures: {
    matches: ['db, err := sql.Open("sqlite3", "app.db")', '_ "github.com/mattn/go-sqlite3"'],
    nonMatches: ['db, err := sql.Open("sqlite3", ":memory:")', 'db, err := sql.Open("postgres", dsn)']
  }
};

const FILE_WRITE_PATTERN = /os\.(WriteFile|Create|OpenFile)\s*\(|ioutil\.WriteFile\s*\(/;

export const localFileWriteRule: SuspectRule = {
  id: "go-local-file-write",
  kind: "local-fs-write",
  confidence: "medium",
  rationale:
    "a file written to a path that isn't configured via an env var lands on this instance's own local disk - another instance (or this one after a restart on an ephemeral filesystem) won't see it",
  test: (line) => FILE_WRITE_PATTERN.test(line) && !line.includes("os.Getenv"),
  fixtures: {
    matches: ['os.WriteFile("data.json", body, 0644)', 'f, err := os.Create("uploads/" + name)'],
    nonMatches: ['os.WriteFile(os.Getenv("DATA_FILE"), body, 0644)']
  }
};

function resolveStartCommand(input: StackDetectionInput): string | undefined {
  // Go compiles to a binary, so there's no dependency directory to share and
  // `go run .` is the portable way in - it builds then runs in one step.
  if (!input.entries.includes("go.mod")) return undefined;
  return "go run .";
}

export const goStack: StackProfile = {
  id: "go",
  displayName: "Go",
  markers: ["go.mod"],
  reads: ["go.mod"],
  // Nothing to link: modules live in the shared module cache outside the project.
  linkDirs: [],
  ignoreDirs: ["vendor", "bin"],
  sourceExtensions: [".go"],
  rules: [
    packageStateRule,
    packageCounterRule,
    randomSessionKeyRule,
    filesystemSessionStoreRule,
    sqliteFileRule,
    localFileWriteRule
  ],
  resolveStartCommand
};
