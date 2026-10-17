import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";

import { TwinError } from "../../domain/errors.js";
import type { FsSnapshot } from "../../domain/workspaceDiff.js";
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
import { isInstanceAlive } from "./isProcessAlive.js";
import { killTree } from "./killTree.js";
import { LogRingBuffer } from "./logRingBuffer.js";
import { createLogSink, type LogSink } from "./logSink.js";
import type { PidRecord } from "./pidFile.js";
import { writePidFile } from "./pidFile.js";
import { getFreePort } from "./portAllocator.js";

const MAX_BOOT_ATTEMPTS = 3;

/** How long a boot failure waits for the child's stdio to drain before giving up on its log tail. */
const LOG_DRAIN_TIMEOUT_MS = 500;

/** What prepare() produced for an instance - needed later by restart(). */
interface PreparedRecord {
  pristineDir: string;
}

/** What start() produced for an instance - needed later by stop()/restart()/logs(). */
interface RunningInstance {
  pid: number;
  dir: string;
  logs: LogTail;
  startSpec: StartSpec;
  startedAt: string;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `build` to completion in `dir` before the app is started. Rejects with TwinError("E_BUILD_FAILED") on a non-zero exit. */
async function runBuild(
  dir: string,
  build: string | undefined,
  instance: string,
  redactLine?: (line: string) => string
): Promise<void> {
  if (build === undefined) return;

  // Redacted like any other captured output: a failing build prints the
  // environment it was given more often than an app does.
  const logs = createLogSink({ redactLine });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(build, { cwd: dir, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk: Buffer) => logs.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => logs.write(chunk));
    child.once("error", (err) => {
      reject(
        new TwinError("E_BUILD_FAILED", `Failed to run build command \`${build}\` for instance ${instance}.`, {
          details: { instance },
          cause: err
        })
      );
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new TwinError(
          "E_BUILD_FAILED",
          `Build command \`${build}\` failed for instance ${instance} (exit code ${code ?? "null"}, signal ${signal ?? "null"}).`,
          { hint: "Run the build command manually to see the full error.", details: { instance, logTail: logs.lines(30) } }
        )
      );
    });
  });
}

/** True if something (anything) accepts a TCP connection on `port` right now. */
async function isPortHeldBySomeoneElse(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const settle = (held: boolean): void => {
      socket.destroy();
      resolve(held);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(500, () => settle(false));
  });
}

async function pollHealth(
  baseUrl: string,
  healthPath: string,
  timeoutMs: number,
  isAlive?: () => boolean
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL(healthPath, baseUrl), { signal: AbortSignal.timeout(1000) });
      if (response.status < 500) return;
    } catch (err) {
      lastError = err;
    }
    // A dead process with nothing answering its port is a crash, not a slow
    // boot. Waiting out the rest of the deadline - three times over, once per
    // boot attempt - only delays the same verdict by minutes. Checked after a
    // failed probe, never before: an app that answers has already returned.
    if (isAlive !== undefined && !isAlive()) break;
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
    private readonly pidFilePath?: string,
    /** When set, each instance's output is also written to `<logDir>/<instance>.log`, readable after the run. */
    private readonly logDir?: string,
    /**
     * Strips secrets from every captured log line before it reaches memory,
     * disk, or a boot-failure's `logTail` (which Twin prints to the terminal).
     */
    private readonly redactLogLine?: (line: string) => string
  ) {}

  private openLogSink(instance: string): LogSink {
    if (this.logDir === undefined) return createLogSink({ redactLine: this.redactLogLine });

    mkdirSync(this.logDir, { recursive: true });
    const stream = createWriteStream(path.join(this.logDir, `${instance}.log`), { flags: "a" });
    return createLogSink({
      redactLine: this.redactLogLine,
      file: { write: (text) => stream.write(text), end: () => stream.end() }
    });
  }

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
    await runBuild(ws.dir, spec.build, ws.instance, this.redactLogLine);

    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_BOOT_ATTEMPTS; attempt++) {
      try {
        return await this.spawnOnce(ws, spec);
      } catch (err) {
        lastErr = err;
        // A start command that hands its server off and exits does it every
        // time. Retrying only spawned another server that escaped too.
        if (TwinError.isTwinError(err) && err.code === "E_BOOT_DETACHED") break;
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

  /**
   * Stops every instance this driver still has running. Not part of the
   * InstanceDriver port: it exists for the CLI's signal handler, which has no
   * handles to pass (they belong to whatever phase was interrupted).
   *
   * A pid whose kill failed stays in the pid file on purpose, so `twin clean`
   * can still find it afterwards.
   */
  async stopAll(opts: StopOptions): Promise<void> {
    const entries = [...this.running.entries()];
    const outcomes = await Promise.allSettled(
      entries.map(([, record]) => killTree(record.pid, { mode: "graceful", graceMs: opts.graceMs }))
    );
    outcomes.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") this.running.delete(entries[index]![0]);
    });
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
    // A fresh clone needs its own build output; "keep" reuses prior.dir, which was already built by start().
    if (opts.disk === "fresh") await runBuild(dir, prior.startSpec.build, handle.id, this.redactLogLine);

    return this.spawnOnce({ instance: handle.id, dir }, prior.startSpec);
  }

  async snapshot(handle: InstanceHandle): Promise<FsSnapshot> {
    const running = this.running.get(handle.id);
    if (running === undefined) return { instance: handle.id, entries: [] };
    return { instance: handle.id, entries: await this.workspaceManager.snapshot(running.dir) };
  }

  logs(handle: InstanceHandle): LogTail {
    return this.running.get(handle.id)?.logs ?? new LogRingBuffer();
  }

  private async spawnOnce(ws: PreparedWorkspace, spec: StartSpec): Promise<InstanceHandle> {
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const logs = this.openLogSink(ws.instance);
    // Most non-Node servers take the port as an argument rather than reading
    // it from the environment, and `$PORT`/`%PORT%` isn't portable across
    // cmd.exe and sh - so Twin substitutes it before handing the command over.
    const command = spec.command.replaceAll("{{port}}", String(port));

    const child = spawn(command, {
      cwd: ws.dir,
      shell: true,
      // POSIX only: makes the child its own process-group leader so killTree()
      // can signal the whole tree via -pid. Deliberately NOT set on Windows -
      // DETACHED_PROCESS there makes the child's output uncapturable by every
      // means (pipes, inherited fds, even the child shell's own `> file`), which
      // left boot failures undiagnosable. Nothing is lost: killTree uses
      // `taskkill /T` to walk the tree on Windows, and Windows doesn't kill
      // children when a parent dies, so `twin clean`'s orphan case still holds.
      detached: process.platform !== "win32",
      windowsHide: true,
      env: { ...process.env, ...spec.env, [spec.portEnv]: String(port) },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let settled = false;
    let spawnError: unknown;
    // spawn() reports a failed exec (ENOENT, EACCES, a cwd that vanished
    // mid-flight, ...) via an 'error' event, not a thrown exception or a
    // rejected promise. With no listener, Node treats that as an uncaught
    // exception and takes the whole process down with it.
    child.on("error", (err) => {
      if (settled) {
        this.logger.warn(`instance ${ws.instance}'s process reported an error after boot`, {
          error: err instanceof Error ? err.message : String(err)
        });
        return;
      }
      spawnError = err;
    });

    child.stdout?.on("data", (chunk: Buffer) => logs.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => logs.write(chunk));
    // 'close', not 'exit': the child's exit can precede its pipes draining, so
    // closing on 'exit' both truncates the log and writes to an ended stream.
    let stdioClosed = false;
    const stdioDrained = new Promise<void>((resolve) => {
      child.once("close", () => {
        stdioClosed = true;
        logs.close();
        resolve();
      });
    });

    /**
     * A boot failure's whole value is the log tail - it's the app's own
     * account of why it died, and Twin prints it to the terminal. The exit is
     * observable before the pipes have drained, though, so reading the tail
     * the instant the process is gone could return nothing at all and leave
     * the failure undiagnosable. Bounded, because a child that never closes
     * its stdio must not hang the run.
     */
    const awaitLogs = async (): Promise<void> => {
      if (stdioClosed) return;
      await Promise.race([stdioDrained, sleep(LOG_DRAIN_TIMEOUT_MS)]);
    };

    const pid = child.pid;
    if (pid === undefined) {
      settled = true;
      throw new TwinError("E_BOOT_CRASH", `Failed to spawn \`${spec.command}\` for instance ${ws.instance}.`, {
        hint: "Check that the start command is correct and the project is installed.",
        details: { instance: ws.instance }
      });
    }

    let exitCode: number | null | undefined;
    let exitInfo = "";
    child.once("exit", (code, signal) => {
      exitCode = code;
      exitInfo = `exit code ${code ?? "null"}, signal ${signal ?? "null"}`;
    });
    // The instance, not the shell that launched it: see isInstanceAlive.
    const instanceAlive = (): boolean => isInstanceAlive(pid);
    /**
     * Ours to release. An orphan that escaped still holds the write ends of
     * these pipes, and while it does Node keeps the read ends open - which
     * kept Twin itself alive after it had reported the failure: hung in CI
     * until the runner's own timeout.
     */
    const releaseStdio = (): void => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    // Recorded here, before the health poll, not after it. The poll can take
    // the whole boot timeout (three attempts of up to 60s), and an instance
    // registered only on success was invisible for that entire window: Ctrl-C
    // in the middle of it found nothing in `running` to stop and nothing in
    // pids.json either, so the process group outlived the run and `twin clean`
    // couldn't see it to reap it. A booting process is exactly as much of a
    // liability as a ready one.
    this.running.set(ws.instance, { pid, dir: ws.dir, logs, startSpec: spec, startedAt: new Date().toISOString() });
    await this.persistPidFile();

    /** Every boot failure below has already killed the process - drop the record with it. */
    const forgetInstance = async (): Promise<void> => {
      this.running.delete(ws.instance);
      await this.persistPidFile();
    };

    try {
      await pollHealth(baseUrl, spec.healthPath, spec.bootTimeoutMs, instanceAlive);
    } catch (err) {
      settled = true;
      // Ask the OS directly rather than trusting the 'exit' event here: it
      // can lag a tick behind the process actually being gone.
      const alreadyDead = !instanceAlive();
      // Unconditionally. Gating this on the leader being alive is how a
      // backgrounded server outlived a failed boot - killTree signals the
      // group, which is exactly what survives a leader that already exited.
      await killTree(pid, { mode: "crash", graceMs: 0 });
      // Only forgotten once it really is gone. A record dropped while the
      // group lived on left pids.json empty, and `twin clean` blind to it.
      if (!instanceAlive()) await forgetInstance();
      await awaitLogs();
      // Pipes still open with every process we know of dead: something we
      // can't see has them - a server handed off to a daemon or its own session.
      const handedOff = !stdioClosed;
      releaseStdio();

      if (alreadyDead && spawnError === undefined && (exitCode === 0 || handedOff)) {
        throw new TwinError(
          "E_BOOT_DETACHED",
          `\`${spec.command}\` exited${exitCode === 0 ? " successfully" : ""} instead of staying in the foreground, so instance ${
            ws.instance
          } never served from a process Twin can see or stop.`,
          {
            hint:
              "Twin has to own the server process to restart it and clean it up. Run it in the foreground: drop a trailing `&`, use `pm2-runtime start` rather than `pm2 start`, and leave off any --daemon / -d flag." +
              (handedOff ? " The server may still be running outside Twin - check its port and stop it yourself." : ""),
            details: { instance: ws.instance, port, logTail: logs.lines(30) },
            cause: err
          }
        );
      }

      if (spawnError !== undefined) {
        throw new TwinError(
          "E_BOOT_CRASH",
          `Failed to spawn \`${spec.command}\` for instance ${ws.instance}: ${
            spawnError instanceof Error ? spawnError.message : String(spawnError)
          }`,
          {
            hint: "Check that the start command is correct and the project is installed.",
            details: { instance: ws.instance, logTail: logs.lines(30) },
            cause: spawnError
          }
        );
      }

      // getFreePort() frees the port immediately after checking it, so
      // another process can grab it before this child binds it (rare, but
      // real: §9.3). If our child is dead yet something still answers on
      // its port, that something isn't us - a reliable, OS-level signal
      // that doesn't depend on scraping the child's stdio for "EADDRINUSE"
      // (which Windows doesn't deliver here once `detached: true` is set).
      if (alreadyDead && (await isPortHeldBySomeoneElse(port))) {
        throw new TwinError(
          "E_PORT_UNAVAILABLE",
          `Instance ${ws.instance} could not bind its assigned port ${port} - something else grabbed it first.`,
          {
            hint: "Re-run `twin run` - this is a rare timing race (Twin frees the port right before handing it to your app) and should succeed on retry.",
            details: { instance: ws.instance, port, logTail: logs.lines(30) },
            cause: err
          }
        );
      }

      throw new TwinError(
        alreadyDead ? "E_BOOT_CRASH" : "E_BOOT_TIMEOUT",
        alreadyDead
          ? `Instance ${ws.instance} crashed on boot${exitInfo.length > 0 ? ` (${exitInfo})` : ""}.`
          : `Instance ${ws.instance} did not become healthy within ${spec.bootTimeoutMs}ms.`,
        {
          hint: alreadyDead
            ? `\`${spec.command}\` exited instead of serving. If the app needs compiling first, pass --build "<command>". The log tail below is the app's own output.`
            : `The app started but never answered ${spec.healthPath} with a non-5xx status. Check --health-path (is it really ${spec.healthPath}?) and --port-env (does the app read ${spec.portEnv}?).`,
          details: { instance: ws.instance, logTail: logs.lines(30) },
          cause: err
        }
      );
    }

    // The instance, not the leader: a backgrounded server whose launching
    // shell has exited is still running in our group, still ours to stop.
    if (!instanceAlive() || spawnError !== undefined) {
      settled = true;
      await killTree(pid, { mode: "crash", graceMs: 0 });
      if (!instanceAlive()) await forgetInstance();
      await awaitLogs();
      releaseStdio();
      throw new TwinError(
        "E_BOOT_CRASH",
        `Instance ${ws.instance} exited right after reporting healthy (${exitInfo}).`,
        { details: { instance: ws.instance, logTail: logs.lines(30) }, cause: spawnError }
      );
    }

    settled = true;
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
