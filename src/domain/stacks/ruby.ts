import type { StackDetectionInput, StackProfile } from "../stack.js";
import type { SuspectRule } from "../suspectRule.js";

// Class variables (@@x), globals ($x) and SCREAMING constants assigned an empty
// container at load time are all one-per-process state.
const SHARED_STATE_PATTERN = /^(@@\w+|\$\w+|[A-Z][A-Z0-9_]*)\s*=\s*(\{\}|\[\]|Hash\.new(\(.*\))?|Set\.new|\{\s*\})\s*(#.*)?$/;

export const sharedStateRule: SuspectRule = {
  id: "rb-class-or-global-container",
  kind: "module-state",
  confidence: "medium",
  rationale:
    "a class variable, global or constant holding a hash/array is per-process state - another instance, or this one after a restart, starts with an empty one",
  test: (line) => SHARED_STATE_PATTERN.test(line),
  fixtures: {
    matches: ["@@sessions = {}", "$cache = {}", "ITEMS = []", "@@notes = Hash.new", "SEEN = Set.new"],
    nonMatches: ["  @@sessions = {}", "CONFIG = { port: 3000 }", "@items = []", "ITEMS = load_items"]
  }
};

const COUNTER_PATTERN = /^(@@\w+|\$\w+)\s*=\s*-?\d+\s*(#.*)?$/;

export const counterRule: SuspectRule = {
  id: "rb-shared-counter",
  kind: "module-state",
  confidence: "low",
  rationale:
    "a per-process counter restarts from its initial value in every process - two instances hand out the same ids, so records collide or overwrite each other",
  test: (line) => COUNTER_PATTERN.test(line),
  fixtures: {
    matches: ["@@next_id = 1", "$counter = 0"],
    nonMatches: ["  @@next_id = 1", "PORT = 3000 # config, not state", "@next_id = 1"]
  }
};

// Rails: a cookie store is fine (stateless and signed); cache/memory stores are not.
const LOCAL_SESSION_STORE_PATTERN =
  /session_store\s+:(cache_store|mem_cache_store)\b|config\.cache_store\s*=\s*:memory_store|use\s+Rack::Session::(Pool|Memcache)\b/;

export const localSessionStoreRule: SuspectRule = {
  id: "rb-local-session-store",
  kind: "memory-session-store",
  confidence: "medium",
  rationale:
    "an in-process session or cache store is local to one instance - sessions created on one aren't visible to the other",
  test: (line) => LOCAL_SESSION_STORE_PATTERN.test(line),
  fixtures: {
    matches: [
      "Rails.application.config.session_store :cache_store",
      "config.cache_store = :memory_store",
      "use Rack::Session::Pool"
    ],
    nonMatches: [
      "Rails.application.config.session_store :cookie_store, key: '_app'",
      "config.cache_store = :redis_cache_store"
    ]
  }
};

// A secret generated at boot differs per process, so signed cookies don't verify across instances.
const RANDOM_SECRET_PATTERN = /secret(_key_base)?\s*(=|=>|:|,)\s*(SecureRandom\.|Random\.|rand\()/;

export const randomSecretRule: SuspectRule = {
  id: "rb-random-secret",
  kind: "memory-session-store",
  confidence: "medium",
  rationale:
    "a secret generated at boot differs in every process, so a cookie signed by one instance fails verification on another - read it from a shared env var instead",
  test: (line) => RANDOM_SECRET_PATTERN.test(line),
  fixtures: {
    matches: ["set :secret, SecureRandom.hex(64)", "config.secret_key_base = SecureRandom.hex"],
    nonMatches: ["config.secret_key_base = ENV['SECRET_KEY_BASE']"]
  }
};

const SQLITE_PATTERN = /adapter:\s*sqlite3|SQLite3::Database\.new|sqlite3:\/\//;

export const sqliteFileRule: SuspectRule = {
  id: "rb-sqlite-file",
  kind: "sqlite-file",
  confidence: "medium",
  rationale: "a SQLite file lives on one instance's local disk - another instance has its own separate (and likely empty) copy",
  test: (line) => SQLITE_PATTERN.test(line) && !line.includes(":memory:"),
  fixtures: {
    matches: ["  adapter: sqlite3", 'db = SQLite3::Database.new("app.db")'],
    nonMatches: ['db = SQLite3::Database.new(":memory:")', "  adapter: postgresql"]
  }
};

const FILE_WRITE_PATTERN = /File\.(write|open)\s*\(|FileUtils\.(cp|mv)\s*\(/;

export const localFileWriteRule: SuspectRule = {
  id: "rb-local-file-write",
  kind: "local-fs-write",
  confidence: "medium",
  rationale:
    "a file written to a path that isn't configured via an env var lands on this instance's own local disk - another instance (or this one after a restart on an ephemeral filesystem) won't see it",
  test: (line) => FILE_WRITE_PATTERN.test(line) && !line.includes("ENV"),
  fixtures: {
    matches: ['File.write("data.json", body)', 'File.open("uploads/#{name}", "wb") { |f| f.write(blob) }'],
    nonMatches: ["File.write(ENV['DATA_FILE'], body)", 'content = File.read("data.json")']
  }
};

function resolveStartCommand(input: StackDetectionInput): string | undefined {
  const has = (name: string): boolean => input.entries.includes(name);
  const bundled = has("Gemfile");
  const prefix = bundled ? "bundle exec " : "";

  // Rails ships bin/rails; both it and rackup take the port as a flag.
  if (has("bin") && /rails/i.test(input.files.Gemfile ?? "")) return `${prefix}rails server -p {{port}} -b 127.0.0.1`;
  if (has("config.ru")) return `${prefix}rackup -p {{port}} -o 127.0.0.1`;
  const script = ["app.rb", "server.rb", "main.rb"].find(has);
  return script === undefined ? undefined : `${prefix}ruby ${script}`;
}

export const rubyStack: StackProfile = {
  id: "ruby",
  displayName: "Ruby",
  markers: ["Gemfile", "config.ru"],
  reads: ["Gemfile"],
  linkDirs: ["vendor"],
  ignoreDirs: ["vendor", ".bundle", "tmp", "log"],
  sourceExtensions: [".rb", ".ru", ".rake"],
  rules: [sharedStateRule, counterRule, localSessionStoreRule, randomSecretRule, sqliteFileRule, localFileWriteRule],
  resolveStartCommand
};
