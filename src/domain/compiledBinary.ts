import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Where Twin puts the executable of a stack it compiles itself (Go): the same
 * path for every run of the same project, outside every workspace.
 *
 * Windows Firewall ties its "allow public and private networks to access this
 * app?" prompt to an executable's path. `go run .` links a fresh executable
 * into a new temp folder every time, so an app listening on all interfaces
 * was asked about once per instance (control, A, B) on every run - and every
 * answer left firewall rules behind for a path that was already gone. One
 * path per project means it's asked about once, ever.
 */
export interface CompiledBinaryInput {
  /** Absolute. */
  projectDir: string;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  homedir: string;
}

/** The per-user cache directory, chosen the way Go's os.UserCacheDir() chooses it. */
export function userCacheDir({ platform, env, homedir }: Omit<CompiledBinaryInput, "projectDir">): string {
  if (platform === "win32") return env.LOCALAPPDATA ?? path.win32.join(homedir, "AppData", "Local");
  if (platform === "darwin") return path.posix.join(homedir, "Library", "Caches");
  const xdg = env.XDG_CACHE_HOME;
  return xdg !== undefined && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(homedir, ".cache");
}

/** `<user cache dir>/twin/bin/<hash of the project path>/<project folder name>[.exe]`. */
export function compiledBinaryPath(input: CompiledBinaryInput): string {
  const paths = input.platform === "win32" ? path.win32 : path.posix;
  const projectDir = paths.resolve(input.projectDir);
  // Windows paths are case-insensitive: C:\Proj and c:\proj are one project,
  // and must be one executable, or the firewall asks about each spelling.
  const key = input.platform === "win32" ? projectDir.toLowerCase() : projectDir;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const name = executableName(paths.basename(key));
  return paths.join(userCacheDir(input), "twin", "bin", hash, input.platform === "win32" ? `${name}.exe` : name);
}

/** Named after the project folder, so a prompt that does still appear names something the user recognises. */
function executableName(folder: string): string {
  const safe = folder.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "");
  return safe.length > 0 ? safe : "app";
}
