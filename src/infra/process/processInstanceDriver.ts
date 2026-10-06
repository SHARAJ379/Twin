import { spawn } from "node:child_process";

import { TwinError } from "../../domain/errors.js";
import type {
  InstanceDriver,
  InstanceHandle,
  LogTail,
  PreparedWorkspace,
  RestartOptions,
  StartSpec,
  StopOptions,
  WorkspaceSpec
} from "../../ports/instanceDriver.js";
import type { Logger } from "../../ports/logger.js";
import type { WorkspaceManager } from "../../ports/workspaceManager.js";
import { isProcessAlive } from "./isProcessAlive.js";
import { killTree } from "./killTree.js";
import { LogRingBuffer } from "./logRingBuffer.js";
import type { PidRecord } from "./pidFile.js";
import { writePidFile } from "./pidFile.js";
import { getFreePort } from "./portAllocator.js";

const MAX_BOOT_ATTEMPTS = 3;

/** What prepare() produced for an instance - needed later by restart(). */
interface PreparedRecord {
  pristineDir: string;
}

/** What start() produced for an instance - needed later by stop()/restart()/logs(). */
interface RunningInstance {
  pid: number;
  dir: string;
  logs: LogRingBuffer;
  startSpec: StartSpec;
  startedAt: string;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollHealth(baseUrl: string, healthPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL(healthPath, baseUrl), { signal: AbortSignal.timeout(1000) });
      if (response.status < 500) return;
    } catch (err) {
      lastError = err;
    }
    await sleep(150);
  }
  throw lastError ?? new Error("health check never returned a response");
}

/** Local-process InstanceDriver (TWIN_ARCHITECTURE.md §7.3). v1's only InstanceDriver implementation. */
export class ProcessInstanceDriver implements InstanceDriver {
  private readonly prepared = new Map<string, PreparedRecord>(); // keyed by InstanceId
  private readonly running = new Map<string, RunningInstance>(); // keyed by InstanceId

  constructor(
    private readonly workspaceManager: WorkspaceManager,
    private readonly logger: Logger,
    /** When set, pids.json is rewritten after every spawn/stop so `twin clean` can reap orphans (§7.3). */
    private readonly pidFilePath?: string
  ) {}

  async prepare(spec: WorkspaceSpec): Promise<PreparedWorkspace> {
    const pristineDir = await this.workspaceManager.preparePristine(spec.sourceDir, {
      link: spec.link,
      ignore: spec.ignore
    });
    const dir = await this.workspaceManager.cloneForInstance(pristineDir, spec.instance);
    this.prepared.set(spec.instance, { pristineDir });
    return { instance: spec.instance, dir };
  }

  async start(ws: PreparedWorkspace, spec: StartSpec): Promise<InstanceHandle> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_BOOT_ATTEMPTS; attempt++) {
      try {
        return await this.spawnOnce(ws, spec);
      } catch (err) {
        lastErr = err;
        this.logger.warn(`boot attempt ${attempt}/${MAX_BOOT_ATTEMPTS} for ${ws.instance} failed`, {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    throw lastErr;
  }

  async stop(handle: InstanceHandle, opts: StopOptions): Promise<void> {
    if (handle.pid === undefined) return;
    await killTree(handle.pid, { mode: "graceful", graceMs: opts.graceMs });
    this.running.delete(handle.id);
    await this.persistPidFile();
  }

  async restart(handle: InstanceHandle, opts: RestartOptions): Promise<InstanceHandle> {
    const prepared = this.prepared.get(handle.id);
    const prior = this.running.get(handle.id);
    if (prepared === undefined || prior === undefined) {
      throw new Error(`restart: no running instance recorded for ${handle.id}`);
    }

    await killTree(prior.pid, { mode: opts.mode, graceMs: 5000 });
    this.running.delete(handle.id);

    const dir =
      opts.disk === "fresh" ? await this.workspaceManager.cloneForInstance(prepared.pristineDir, handle.id) : prior.dir;

    return this.spawnOnce({ instance: handle.id, dir }, prior.startSpec);
  }

  logs(handle: InstanceHandle): LogTail {
    return this.running.get(handle.id)?.logs ?? new LogRingBuffer();
  }

  private async spawnOnce(ws: PreparedWorkspace, spec: StartSpec): Promise<InstanceHandle> {
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const logs = new LogRingBuffer();

    const child = spawn(spec.command, {
      cwd: ws.dir,
      shell: true,
      // On POSIX this makes the child its own process-group leader, so
      // killTree() can signal the whole tree via -pid. On Windows, Node's
      // docs call this out separately: detached is *also* what lets the
      // child outlive this process if we crash - without it we lose the
      // orphan-survival guarantee twin clean depends on.
      detached: true,
      windowsHide: true,
      env: { ...process.env, ...spec.env, [spec.portEnv]: String(port) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.on("data", (chunk: Buffer) => logs.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => logs.write(chunk));

    const pid = child.pid;
    if (pid === undefined) {
      throw new TwinError("E_BOOT_CRASH", `Failed to spawn \`${spec.command}\` for instance ${ws.instance}.`, {
        hint: "Check that the start command is correct and the project is installed.",
        details: { instance: ws.instance }
      });
    }

    let exited = false;
    let exitInfo = "";
    child.once("exit", (code, signal) => {
      exited = true;
      exitInfo = `exit code ${code ?? "null"}, signal ${signal ?? "null"}`;
    });

    try {
      await pollHealth(baseUrl, spec.healthPath, spec.bootTimeoutMs);
    } catch (err) {
      // Ask the OS directly rather than trusting our `exited` flag here: the
      // 'exit' event can lag a tick behind the process actually being gone,
      // so reading it right now would be a race.
      const alreadyDead = !isProcessAlive(pid);
      if (!alreadyDead) await killTree(pid, { mode: "crash", graceMs: 0 });
      throw new TwinError(
        alreadyDead ? "E_BOOT_CRASH" : "E_BOOT_TIMEOUT",
        alreadyDead
          ? `Instance ${ws.instance} crashed on boot${exitInfo.length > 0 ? ` (${exitInfo})` : ""}.`
          : `Instance ${ws.instance} did not become healthy within ${spec.bootTimeoutMs}ms.`,
        { details: { instance: ws.instance, logTail: logs.lines(30) }, cause: err }
      );
    }

    if (exited) {
      throw new TwinError(
        "E_BOOT_CRASH",
        `Instance ${ws.instance} exited right after reporting healthy (${exitInfo}).`,
        { details: { instance: ws.instance, logTail: logs.lines(30) } }
      );
    }

    this.running.set(ws.instance, { pid, dir: ws.dir, logs, startSpec: spec, startedAt: new Date().toISOString() });
    await this.persistPidFile();
    return { id: ws.instance, baseUrl, pid, state: "ready" };
  }

  private async persistPidFile(): Promise<void> {
    if (this.pidFilePath === undefined) return;
    const records: PidRecord[] = [...this.running.entries()].map(([instance, r]) => ({
      pid: r.pid,
      instance,
      command: r.startSpec.command,
      startedAt: r.startedAt
    }));
    await writePidFile(this.pidFilePath, records);
  }
}
