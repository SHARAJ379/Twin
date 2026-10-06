import type { InstanceId } from "../domain/instance.js";
import type { FsSnapshot } from "../domain/workspaceDiff.js";

export interface WorkspaceSpec {
  instance: InstanceId;
  /** Absolute path to the real project to clone from. */
  sourceDir: string;
  /** Directory names junction/symlinked instead of deep-copied, e.g. "node_modules". */
  link: string[];
  /** Extra top-level names to skip when copying. */
  ignore: string[];
}

export interface PreparedWorkspace {
  instance: InstanceId;
  dir: string;
}

export interface StartSpec {
  /** Shell command to run, e.g. "npm start". */
  command: string;
  /** Env var the app reads its port from (default "PORT"). */
  portEnv: string;
  /** Extra env vars, merged over process.env. Values are never logged (I5). */
  env: Record<string, string>;
  /** Path polled for readiness, e.g. "/health". */
  healthPath: string;
  bootTimeoutMs: number;
}

export type InstanceState = "starting" | "ready" | "down" | "restarting";

export interface InstanceHandle {
  id: InstanceId;
  baseUrl: string;
  pid?: number;
  state: InstanceState;
}

export interface LogTail {
  lines(count: number): string[];
}

export interface StopOptions {
  graceMs: number;
}

export interface RestartOptions {
  mode: "crash" | "graceful";
  /** "fresh" re-clones from the pristine copy (matches the ephemeral profile); "keep" reuses the same dir. */
  disk: "fresh" | "keep";
}

/**
 * v1 implementation: ProcessDriver (local processes). Later: DockerDriver,
 * ComposeDriver, an "attach to already-running staging" driver - none of
 * which should require changes to the application layer (§13).
 */
export interface InstanceDriver {
  prepare(spec: WorkspaceSpec): Promise<PreparedWorkspace>;
  /** Resolves once the instance answers its health path, or throws TwinError("E_BOOT_TIMEOUT"/"E_BOOT_CRASH"). */
  start(ws: PreparedWorkspace, spec: StartSpec): Promise<InstanceHandle>;
  /** SIGTERM (graceMs to exit) then SIGKILL, whole process tree. Idempotent. */
  stop(handle: InstanceHandle, opts: StopOptions): Promise<void>;
  restart(handle: InstanceHandle, opts: RestartOptions): Promise<InstanceHandle>;
  logs(handle: InstanceHandle): LogTail;
  /** Walks the instance's workspace (§7.5) - take one before and one after the scenario runs, then diff them. */
  snapshot(handle: InstanceHandle): Promise<FsSnapshot>;
}
