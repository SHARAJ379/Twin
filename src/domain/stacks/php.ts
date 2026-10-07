import type { StackDetectionInput, StackProfile } from "../stack.js";
import type { SuspectRule } from "../suspectRule.js";

// Laravel/Symfony read these from .env, and both default to per-instance local storage.
const LOCAL_DRIVER_PATTERN = /^(SESSION_DRIVER|CACHE_DRIVER|CACHE_STORE|QUEUE_CONNECTION)\s*=\s*(file|array|sync)\s*$/i;

export const localDriverRule: SuspectRule = {
  id: "php-local-session-driver",
  kind: "memory-session-store",
  confidence: "medium",
  rationale:
    "a file or array session/cache driver stores state on this instance only - a request served by the other instance can't see it (and `array` is lost the moment the process ends)",
  test: (line) => LOCAL_DRIVER_PATTERN.test(line.trim()),
  fixtures: {
    matches: ["SESSION_DRIVER=file", "CACHE_DRIVER=array", "QUEUE_CONNECTION=sync"],
    nonMatches: ["SESSION_DRIVER=redis", "CACHE_DRIVER=memcached", "# SESSION_DRIVER=file"]
  }
};

const CONFIG_DRIVER_PATTERN = /["']driver["']\s*=>\s*env\s*\(\s*["'](SESSION_DRIVER|CACHE_DRIVER)["']\s*,\s*["'](file|array)["']/;

export const configDriverDefaultRule: SuspectRule = {
  id: "php-config-local-driver-default",
  kind: "memory-session-store",
  confidence: "medium",
  rationale:
    "the config falls back to a file/array driver when the env var is unset, so a deploy that forgets to set it silently gets per-instance sessions",
  test: (line) => CONFIG_DRIVER_PATTERN.test(line),
  fixtures: {
    matches: ["'driver' => env('SESSION_DRIVER', 'file'),"],
    nonMatches: ["'driver' => env('SESSION_DRIVER', 'redis'),"]
  }
};

// Plain PHP: the default session handler writes files to this machine's disk.
const SESSION_START_PATTERN = /\bsession_start\s*\(\s*\)/;

export const defaultSessionHandlerRule: SuspectRule = {
  id: "php-default-session-handler",
  kind: "memory-session-store",
  confidence: "medium",
  rationale:
    "PHP's default session handler writes session files to this instance's local disk - another instance looks in its own empty directory and sees the user as logged out",
  test: (line, fullFileContent) => SESSION_START_PATTERN.test(line) && !/session_set_save_handler|session\.save_path/.test(fullFileContent),
  fixtures: {
    matches: ["session_start();"],
    nonMatches: ["session_set_save_handler($handler, true);\nsession_start();"]
  }
};

const MODULE_STATE_PATTERN = /^(static\s+)?\$[A-Za-z_]\w*\s*=\s*(\[\s*\]|array\s*\(\s*\))\s*;\s*(\/\/.*)?$/;

export const moduleStateRule: SuspectRule = {
  id: "php-file-level-array",
  kind: "module-state",
  confidence: "low",
  rationale:
    "a file-level array only lives for the current request in classic PHP, and across requests in a long-running server it's per-process either way - neither shares state with the other instance",
  test: (line) => MODULE_STATE_PATTERN.test(line),
  fixtures: {
    matches: ["$items = [];", "static $cache = array();"],
    nonMatches: ["  $items = [];", "$items = load_items();", "$config = ['port' => 8000];"]
  }
};

const SQLITE_PATTERN = /DB_CONNECTION\s*=\s*sqlite|new\s+(PDO|SQLite3)\s*\(\s*["']sqlite:/i;

export const sqliteFileRule: SuspectRule = {
  id: "php-sqlite-file",
  kind: "sqlite-file",
  confidence: "medium",
  rationale: "a SQLite file lives on one instance's local disk - another instance has its own separate (and likely empty) copy",
  test: (line) => SQLITE_PATTERN.test(line) && !line.includes(":memory:"),
  fixtures: {
    matches: ["DB_CONNECTION=sqlite", "$db = new PDO('sqlite:database/app.sqlite');"],
    nonMatches: ["DB_CONNECTION=mysql", "$db = new PDO('sqlite::memory:');"]
  }
};

const FILE_WRITE_PATTERN = /\b(file_put_contents|move_uploaded_file|fwrite)\s*\(/;

export const localFileWriteRule: SuspectRule = {
  id: "php-local-file-write",
  kind: "local-fs-write",
  confidence: "medium",
  rationale:
    "a file written to a path that isn't configured via an env var lands on this instance's own local disk - another instance (or this one after a restart on an ephemeral filesystem) won't see it",
  test: (line) => FILE_WRITE_PATTERN.test(line) && !/getenv|\$_ENV|env\s*\(/.test(line),
  fixtures: {
    matches: ["file_put_contents('data.json', $body);", "move_uploaded_file($tmp, 'uploads/' . $name);"],
    nonMatches: ["file_put_contents(getenv('DATA_FILE'), $body);", "$data = file_get_contents('data.json');"]
  }
};

function resolveStartCommand(input: StackDetectionInput): string | undefined {
  const has = (name: string): boolean => input.entries.includes(name);

  if (has("artisan")) return "php artisan serve --host=127.0.0.1 --port={{port}}";
  // PHP's built-in server needs a document root; public/ is the near-universal convention.
  if (has("public")) return "php -S 127.0.0.1:{{port}} -t public";
  if (has("index.php")) return "php -S 127.0.0.1:{{port}}";
  return undefined;
}

export const phpStack: StackProfile = {
  id: "php",
  displayName: "PHP",
  markers: ["composer.json", "artisan", "index.php"],
  reads: ["composer.json"],
  linkDirs: ["vendor"],
  ignoreDirs: ["vendor", "storage", "node_modules"],
  sourceExtensions: [".php", ".env"],
  rules: [
    localDriverRule,
    configDriverDefaultRule,
    defaultSessionHandlerRule,
    moduleStateRule,
    sqliteFileRule,
    localFileWriteRule
  ],
  resolveStartCommand
};
