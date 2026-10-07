import type { StackDetectionInput, StackProfile } from "../stack.js";
import type { SuspectRule } from "../suspectRule.js";

// Column 0 means module scope: indented means it's inside a function or class,
// where a fresh container per call is usually the point.
const MODULE_STATE_PATTERN =
  /^\w+(\s*:\s*[\w[\], .]+)?\s*=\s*(\{\}|\[\]|set\(\)|dict\(\)|list\(\)|OrderedDict\(\)|defaultdict\(.*\)|Counter\(\))\s*(#.*)?$/;

export const moduleStateRule: SuspectRule = {
  id: "py-module-level-container",
  kind: "module-state",
  confidence: "medium",
  rationale:
    "a module-level dict/list/set mutated by request handlers lives in this worker process's memory only - another instance, or this one after a restart, starts with an empty one",
  test: (line) => MODULE_STATE_PATTERN.test(line),
  fixtures: {
    matches: [
      "SESSIONS = {}",
      "items = []",
      "seen = set()",
      "cache = dict()",
      "notes: dict[str, str] = {}",
      "counts = Counter()",
      "users = {}  # email -> user"
    ],
    nonMatches: ["    SESSIONS = {}", "\tcache = {}", "CONFIG = {'port': 8000}", "items = load_items()"]
  }
};

// Python has no const, so `PORT = 8000` and `next_id = 1` are syntactically
// identical. Two conventions separate them: constants are UPPER_CASE, and a
// counter's name says what it is. Both are required, which is also why this
// rule stays at "low".
const MODULE_COUNTER_PATTERN = /^([a-z_]\w*)\s*(:\s*int\s*)?=\s*-?\d+\s*(#.*)?$/;
const COUNTER_NAME_PATTERN = /(^|_)(next|count|counter|seq|sequence|id|idx|index)(_|$)/;

export const moduleCounterRule: SuspectRule = {
  id: "py-module-level-counter",
  kind: "module-state",
  confidence: "low",
  rationale:
    "a module-level counter restarts from its initial value in every worker process - two instances hand out the same ids, so records collide or overwrite each other",
  test: (line) => {
    const name = MODULE_COUNTER_PATTERN.exec(line)?.[1];
    return name !== undefined && COUNTER_NAME_PATTERN.test(name);
  },
  fixtures: {
    matches: ["next_id = 1", "counter = 0", "next_note_id: int = 1  # ids start at 1", "seq = 0"],
    nonMatches: [
      "    next_id = 1",
      "PORT = 8000  # a constant, not state",
      "timeout = 30",
      "total = len(items)",
      "next_id = compute()"
    ]
  }
};

// A secret generated at import time differs in every process, so each instance
// signs cookies with a different key and rejects the others' sessions.
const RANDOM_SECRET_PATTERN =
  /(secret_key|SECRET_KEY)\s*=\s*(os\.urandom|secrets\.token_(hex|bytes|urlsafe)|uuid\.uuid4|random\.)/;

export const randomSecretPerProcessRule: SuspectRule = {
  id: "py-random-secret-key",
  kind: "memory-session-store",
  confidence: "medium",
  rationale:
    "a secret key generated at import time is different in every process, so signed session cookies issued by one instance fail validation on another - set it from an env var shared by both",
  test: (line) => RANDOM_SECRET_PATTERN.test(line),
  fixtures: {
    matches: ["app.secret_key = os.urandom(24)", "SECRET_KEY = secrets.token_hex(32)", "app.secret_key = uuid.uuid4().hex"],
    nonMatches: ['app.secret_key = os.environ["SECRET_KEY"]', 'SECRET_KEY = os.getenv("SECRET_KEY", "dev")']
  }
};

// Flask-Session and Flask-Caching default to per-process backends.
const LOCAL_SESSION_BACKEND_PATTERN =
  /SESSION_TYPE["']?\s*\]?\s*[:=]\s*["'](filesystem|null)["']|CACHE_TYPE["']?\s*\]?\s*[:=]\s*["'](SimpleCache|simple|filesystem|FileSystemCache)["']/;

export const localSessionBackendRule: SuspectRule = {
  id: "py-local-session-backend",
  kind: "memory-session-store",
  confidence: "medium",
  rationale:
    "a filesystem or simple/in-process session or cache backend is local to one instance - the other instance can't read what this one stored",
  test: (line) => LOCAL_SESSION_BACKEND_PATTERN.test(line),
  fixtures: {
    matches: [
      'app.config["SESSION_TYPE"] = "filesystem"',
      "SESSION_TYPE = 'filesystem'",
      'app.config["CACHE_TYPE"] = "SimpleCache"'
    ],
    nonMatches: ['app.config["SESSION_TYPE"] = "redis"', 'app.config["CACHE_TYPE"] = "RedisCache"']
  }
};

const SQLITE_PATTERN = /sqlite3\.connect\s*\(|["']sqlite:\/\/\/|SQLALCHEMY_DATABASE_URI["']?\s*\]?\s*[:=]\s*["']sqlite/;

export const sqliteFileRule: SuspectRule = {
  id: "py-sqlite-file",
  kind: "sqlite-file",
  confidence: "medium",
  rationale: "a SQLite file lives on one instance's local disk - another instance has its own separate (and likely empty) copy",
  test: (line) => SQLITE_PATTERN.test(line) && !line.includes(":memory:"),
  fixtures: {
    matches: ['conn = sqlite3.connect("app.db")', 'SQLALCHEMY_DATABASE_URI = "sqlite:///app.db"'],
    nonMatches: ['conn = sqlite3.connect(":memory:")', 'SQLALCHEMY_DATABASE_URI = "postgresql://host/db"']
  }
};

// open(..., "w"/"a") and Path.write_* land on this instance's own disk unless
// the path came from the environment (where both instances can be pointed at one place).
const FILE_WRITE_PATTERN = /\bopen\s*\([^)]*["'][wa]b?\+?["']|\.write_(text|bytes)\s*\(|shutil\.copy\w*\s*\(/;

export const localFileWriteRule: SuspectRule = {
  id: "py-local-file-write",
  kind: "local-fs-write",
  confidence: "medium",
  rationale:
    "a file written to a path that isn't configured via an env var lands on this instance's own local disk - another instance (or this one after a restart on an ephemeral filesystem) won't see it",
  test: (line) => FILE_WRITE_PATTERN.test(line) && !/os\.environ|os\.getenv/.test(line),
  fixtures: {
    matches: ['with open("data.json", "w") as f:', 'Path("uploads/x.txt").write_text(body)', 'open(dest, "wb").write(blob)'],
    nonMatches: ['with open(os.environ["DATA_FILE"], "w") as f:', 'with open("data.json") as f:', "data = f.read()"]
  }
};

function resolveStartCommand(input: StackDetectionInput): string | undefined {
  const has = (name: string): boolean => input.entries.includes(name);

  // The project's dependencies are in its virtualenv, not on the PATH `python`
  // resolves to, so the interpreter has to be named explicitly. The venv is
  // linked into each workspace, so a relative path is correct there.
  const venv = [".venv", "venv"].find(has);
  const python =
    venv === undefined ? "python" : input.isWindows ? `${venv}\\Scripts\\python.exe` : `./${venv}/bin/python`;

  // Django's own runserver takes the bind address positionally.
  if (has("manage.py")) return `${python} manage.py runserver 127.0.0.1:{{port}}`;

  const pyproject = input.files["pyproject.toml"] ?? "";
  const requirements = input.files["requirements.txt"] ?? "";
  const declares = (pkg: string): boolean =>
    new RegExp(`(^|[^\\w-])${pkg}([^\\w-]|$)`, "im").test(pyproject) || new RegExp(`^${pkg}\\b`, "im").test(requirements);

  // uvicorn/FastAPI and Flask both need the module path, which we can only
  // guess from the conventional entrypoint filenames.
  const asgiEntry = ["main.py", "app.py", "asgi.py", "server.py"].find(has);
  if ((declares("fastapi") || declares("uvicorn")) && asgiEntry !== undefined) {
    return `${python} -m uvicorn ${asgiEntry.replace(/\.py$/, "")}:app --host 127.0.0.1 --port {{port}}`;
  }
  if (declares("flask")) {
    const flaskEntry = ["app.py", "main.py", "wsgi.py"].find(has);
    if (flaskEntry !== undefined) {
      return `${python} -m flask --app ${flaskEntry.replace(/\.py$/, "")} run --port {{port}}`;
    }
  }

  // A plain script that starts its own server: it has to read PORT itself,
  // which is what portEnv is for.
  const script = ["app.py", "main.py", "server.py"].find(has);
  return script === undefined ? undefined : `${python} ${script}`;
}

export const pythonStack: StackProfile = {
  id: "python",
  displayName: "Python",
  markers: ["requirements.txt", "pyproject.toml", "Pipfile", "manage.py"],
  reads: ["pyproject.toml", "requirements.txt"],
  linkDirs: [".venv", "venv"],
  ignoreDirs: [".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "site-packages"],
  sourceExtensions: [".py"],
  rules: [
    moduleStateRule,
    moduleCounterRule,
    randomSecretPerProcessRule,
    localSessionBackendRule,
    sqliteFileRule,
    localFileWriteRule
  ],
  resolveStartCommand
};
