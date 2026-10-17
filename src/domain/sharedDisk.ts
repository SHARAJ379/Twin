import type { Finding } from "./check.js";

/**
 * Twin runs A and B on one machine, so anything they keep outside their own
 * workspaces is shared between them by accident: a hardcoded `/tmp/items.json`,
 * a `DATA_FILE=/home/me/app/data.json`, a SQLite file, PHP's session files in
 * the system temp dir. Every multi-instance check then passes - and in
 * production, on two servers or two containers, each one has its own copy.
 *
 * This module decides which paths to watch for that, and what a write to one
 * means for the checks. The watching itself is infra's (snapshotPaths.ts).
 */

/** An absolute path some env value points at - a candidate shared store. */
export interface EnvPath {
  key: string;
  path: string;
}

/**
 * Ambient settings every shell has, which name tools and the user's own
 * directories, not where an app keeps its data.
 */
const AMBIENT_KEY =
  /^(PATH|PATHEXT|HOME|USERPROFILE|HOMEPATH|HOMEDRIVE|APPDATA|LOCALAPPDATA|PROGRAMDATA|ALLUSERSPROFILE|PUBLIC|TMP|TEMP|TMPDIR|SHELL|PWD|OLDPWD|COMSPEC|SYSTEMROOT|SYSTEMDRIVE|WINDIR|DRIVERDATA|ONEDRIVE.*|PROGRAMFILES.*|COMMONPROGRAMFILES.*|PSMODULEPATH|INIT_CWD|EDITOR|VISUAL|PAGER|MAIL|XDG_.*|.*_HOME|NODE_.*|NPM_.*|PYTHON.*|VIRTUAL_ENV|CONDA_.*|GEM_.*|BUNDLE_.*|RBENV_.*|COMPOSER_.*|GO(PATH|ROOT|BIN|CACHE|MODCACHE|ENV)|CARGO_.*|RUSTUP_.*|JAVA_.*|SSL_CERT_.*|.*_CA_.*|GIT_.*|RUNNER_.*|GITHUB_.*|ACTIONS_.*|AGENT_.*|BUILD_.*|VSCODE_.*|TERM_.*|DOTNET_.*|NVM_.*|VOLTA_.*|FNM_.*|ASDF_.*|PNPM_.*|YARN_.*|CHROME_.*|ANDROID_.*|DEVELOPER_DIR|LOGONSERVER|USERDOMAIN.*|ONEDRIVE)$/i;

/** Settings named for where an app keeps data - looked at even when they come from the shell. */
const DATA_KEY = /(^|_)(DATA|DB|DATABASE|SQLITE|STORE|STORAGE|UPLOADS?|FILES?|DIR|FOLDER|SESSIONS?|CACHE|ITEMS)(_|$)/i;

/**
 * The local path a value names, if it names one: `/var/data/app.json`,
 * `C:\data\app.db`, `sqlite:////abs/app.db`, `file:/abs/app.db`.
 */
export function localPathIn(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || /[\n;]/.test(trimmed)) return undefined;
  const url = /^(sqlite3?|file):([^?#]*)/i.exec(trimmed);
  if (url !== null) {
    let rest = url[2]!;
    if (rest.startsWith("//")) rest = rest.slice(2); // the (empty) authority
    // SQLAlchemy's form: `sqlite:///rel.db` is relative, `sqlite:////abs.db` absolute.
    if (url[1]!.toLowerCase().startsWith("sqlite") && rest.startsWith("/")) rest = rest.slice(1);
    rest = decodeURIComponent(rest).replace(/^\/([A-Za-z]:[\\/])/, "$1");
    return isAbsolute(rest) ? rest : undefined;
  }
  return isAbsolute(trimmed) && !trimmed.includes(" -") ? trimmed : undefined;
}

function isAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]./.test(p) || /^\/[^/]/.test(p);
}

/**
 * Every absolute path the instances' environment points at. Values the user
 * set for this app (`.env`, twin.config.json, `--env`) all count; values
 * merely inherited from the shell only when the key says it is app data, so
 * `JAVA_HOME` and `APPDATA` aren't mistaken for a store.
 */
export function localPathsInEnv(
  sources: { vars: Readonly<Record<string, string | undefined>>; ambient: boolean }[],
  /** The platform's path-list separator (path.delimiter): a list of paths is a search path, not a store. */
  delimiter: string
): EnvPath[] {
  const found = new Map<string, EnvPath>();
  for (const source of sources) {
    for (const [key, value] of Object.entries(source.vars)) {
      if (value === undefined || AMBIENT_KEY.test(key)) continue;
      if (source.ambient && !DATA_KEY.test(key)) continue;
      if (delimiter === ";" ? value.includes(";") : value.includes(":/")) continue;
      const local = localPathIn(value);
      if (local !== undefined) found.set(`${key}\0${local}`, { key, path: local });
    }
  }
  return [...found.values()];
}

/**
 * Whether `child` is `root` or inside it. Case-insensitive on Windows, where
 * the file system is.
 */
export function isWithin(child: string, root: string, sep: string, caseInsensitive: boolean): boolean {
  const norm = (p: string): string => {
    const unified = p.replace(/[\\/]+/g, sep).replace(new RegExp(`\\${sep}$`), "");
    return caseInsensitive ? unified.toLowerCase() : unified;
  };
  const c = norm(child);
  const r = norm(root);
  return c === r || c.startsWith(r + sep);
}

/** A file's state, enough to tell it was written: new, gone, resized, or touched. */
export interface FileState {
  size: number;
  mtimeMs: number;
}

/** Paths whose state differs between two snapshots - created, changed, or deleted. */
export function changedPaths(before: ReadonlyMap<string, FileState>, after: ReadonlyMap<string, FileState>): string[] {
  const changed: string[] = [];
  for (const [file, state] of after) {
    const was = before.get(file);
    if (was === undefined || was.size !== state.size || was.mtimeMs !== state.mtimeMs) changed.push(file);
  }
  for (const file of before.keys()) if (!after.has(file)) changed.push(file);
  return changed.sort();
}

/**
 * What a write to shared local disk means for the run's findings: any check
 * that passed can't be told apart from one that passed only because A and B
 * read the same file, which two servers wouldn't. It becomes "not proven" -
 * status error, so the verdict is "Twin could not tell" (exit 2), never a
 * clean bill of health - and says which paths, and the two ways out.
 */
export function markUnprovenByLocalDisk(findings: readonly Finding[], written: readonly string[]): Finding[] {
  if (written.length === 0) return [...findings];
  const shown = written.slice(0, 3).join(", ") + (written.length > 3 ? ` (and ${written.length - 3} more)` : "");
  return findings.map((finding): Finding => {
    if (finding.status !== "pass") return finding;
    return {
      ...finding,
      status: "error",
      summary: `passed, but both instances wrote to ${shown} - a file outside their own workspaces that they only share because they run on one machine`,
      reason:
        "two servers or containers would each have their own copy of that file, so this pass doesn't show the app is safe to run on more than one instance. Move the data to a store every instance reaches (a database, object storage, a mounted volume) - or, if that path really is shared storage in production too, list it in \"sharedPaths\" in twin.config.json",
      unprovenBy: "shared-local-disk"
    };
  });
}
