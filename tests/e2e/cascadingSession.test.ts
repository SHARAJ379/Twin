import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCommand } from "../../src/cli/commands/run.js";
import { ConsoleLogger } from "../../src/infra/log/consoleLogger.js";

const logger = new ConsoleLogger({ level: "error" });

/**
 * The shape of an Express app with express-session (MemoryStore) or
 * cookie-session, notes in an in-memory Map and multer-style uploads on local
 * disk - in plain Node, so the test needs no installs. SESSIONS picks the
 * session store: "memory" (lost across instances) or "signed" (a cookie any
 * instance with SESSION_SECRET can verify).
 */
const APP = `
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const sessions = new Map();
const notes = new Map(); let nextId = 1;
const UPLOADS = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOADS, { recursive: true });
const sign = (v) => v + "." + crypto.createHmac("sha256", process.env.SESSION_SECRET || "s").update(v).digest("hex");
const userOf = (req) => {
  const sid = decodeURIComponent((req.headers.cookie || "").split("sid=")[1] || "").split(";")[0];
  if (process.env.SESSIONS === "signed") { const v = sid.slice(0, sid.lastIndexOf(".")); return sid && sign(v) === sid ? v : undefined; }
  return sessions.get(sid);
};
http.createServer((req, res) => {
  const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    if (req.url === "/health") return send(200, { ok: true });
    if (req.method === "POST" && req.url === "/login") {
      const name = JSON.parse(raw.toString()).name;
      let sid;
      if (process.env.SESSIONS === "signed") sid = sign(name);
      else { sid = crypto.randomUUID(); sessions.set(sid, name); }
      return send(200, { ok: true }, { "set-cookie": "sid=" + encodeURIComponent(sid) + "; Path=/; HttpOnly" });
    }
    const user = userOf(req);
    if (user === undefined) return send(401, { error: "not logged in" });
    if (req.url === "/me") return send(200, { user });
    if (req.method === "POST" && req.url === "/notes") {
      const id = String(nextId++);
      notes.set(id, { id, text: "twin-note" });
      return send(201, { id });
    }
    if (req.url.startsWith("/notes/")) { const n = notes.get(req.url.slice(7)); return n ? send(200, n) : send(404, {}); }
    if (req.method === "POST" && req.url === "/upload") {
      const filename = crypto.randomUUID() + ".txt";
      fs.writeFileSync(path.join(UPLOADS, filename), raw);
      return send(201, { filename });
    }
    if (req.url.startsWith("/files/")) {
      const file = path.join(UPLOADS, path.basename(req.url.slice(7)));
      return fs.existsSync(file) ? send(200, { ok: true }) : send(404, {});
    }
    send(404, {});
  });
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

// The audit's scenario, with no via: anywhere.
const SCENARIO = `name: notes
version: 1
steps:
  - id: login
    kind: request
    request: { method: POST, path: /login, json: { name: alice } }
    expect: { status: 200 }
  - id: me
    kind: request
    request: { method: GET, path: /me }
    expect: { status: 200 }
    check: session-survives-switch
  - id: create-note
    kind: request
    request: { method: POST, path: /notes, json: { text: twin-note } }
    expect: { status: 201 }
    save: { id: "$.id" }
  - id: read-note
    kind: request
    request: { method: GET, path: "/notes/{{id}}" }
    expect: { status: 200 }
    check: data-consistency
  - id: upload
    kind: request
    request: { method: POST, path: /upload, multipart: { generate: { name: "twin.txt", content: "hello {{unique}}" } } }
    expect: { status: 201 }
    save: { filename: "$.filename" }
  - id: read-file
    kind: request
    request: { method: GET, path: "/files/{{filename}}" }
    expect: { status: 200 }
    check: file-consistency
  - id: restart-a
    kind: restart
    instance: A
  - id: read-after-restart
    kind: request
    request: { method: GET, path: "/notes/{{id}}" }
    expect: { status: 200 }
    check: restart-persistence
`;

interface Report {
  findings: { checkId: string; status: string; summary: string; blockedBy?: string }[];
}

/**
 * Found by testing the packed tarball: create-note was round-robined to the
 * other instance and got a 401, so no id was saved and two later checks were
 * never sent - yet Twin printed "3 bugs found" and called data-consistency
 * "could not be read back (status no response)". One session bug is one bug.
 */
describe("a session bug early in a scenario with no via:", () => {
  let projectDir: string;

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const run = (sessions: "memory" | "signed"): Promise<{ exitCode: number; report: Report; terminal: string }> =>
    runWith(SCENARIO, sessions);

  async function runWith(
    scenario: string,
    sessions: "memory" | "signed" = "memory"
  ): Promise<{ exitCode: number; report: Report; terminal: string }> {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "cascade-fixture-"));
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "cascade-fixture", private: true }), "utf8");
    await writeFile(path.join(projectDir, "server.js"), APP, "utf8");
    await writeFile(path.join(projectDir, "scenario.yaml"), scenario, "utf8");

    const printed: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printed.push(args.join(" "));
    });
    const exitCode = await runCommand(
      {
        projectDir,
        scenarioPath: path.join(projectDir, "scenario.yaml"),
        env: { SESSIONS: sessions, SESSION_SECRET: "placeholder-secret" },
        start: "node server.js",
        bootTimeoutMs: 30_000,
        keepWorkspaces: false,
        allowRemote: false
      },
      logger
    ).finally(() => log.mockRestore());

    const latest = await readFile(path.join(projectDir, ".twin", "latest"), "utf8");
    const report = JSON.parse(await readFile(path.join(projectDir, ".twin", "runs", latest, "report.json"), "utf8")) as Report;
    return { exitCode, report, terminal: printed.join("\n") };
  }

  const statusOf = (report: Report): Record<string, string> =>
    Object.fromEntries(report.findings.map((f) => [f.checkId, f.blockedBy !== undefined ? `blocked:${f.blockedBy}` : f.status]));

  it("in-memory sessions: one bug, and every later check genuinely tested or blocked by it", async () => {
    const { exitCode, report, terminal } = await run("memory");

    expect(statusOf(report)).toEqual({
      "session-survives-switch": "fail",
      "data-consistency": "blocked:auth",
      "file-consistency": "blocked:auth",
      "restart-persistence": "blocked:auth"
    });
    expect(terminal).toContain("1 bug found (session-survives-switch);");
    expect(terminal).not.toContain("no response");
    expect(terminal.match(/Fix prompt/g)).toHaveLength(1);
    expect(exitCode).toBe(1);
  }, 120_000);

  it("blocks a check whose request was never sent, naming the step that failed first - never a bug of its own", async () => {
    // An explicit via: is kept, so create-note goes to B, where the session isn't.
    const pinned = SCENARIO.replace(
      "  - id: create-note\n    kind: request\n",
      "  - id: create-note\n    kind: request\n    via: B\n"
    ).replace("    request: { method: POST, path: /login", "    via: A\n    request: { method: POST, path: /login");
    const { report, terminal } = await runWith(pinned);

    const data = report.findings.find((f) => f.checkId === "data-consistency")!;
    expect(data).toMatchObject({ status: "error", blockedBy: "dependency" });
    expect(data.summary).toContain('step "create-note" failed first (status 401)');
    expect(terminal).not.toMatch(/bugs? found \([^)]*data-consistency/);
    expect(terminal).not.toContain("no response");
  }, 120_000);

  it("signed-cookie sessions: the session passes, and the data, file and restart bugs are all found", async () => {
    const { exitCode, report } = await run("signed");

    expect(statusOf(report)).toEqual({
      "session-survives-switch": "pass",
      "data-consistency": "fail",
      "file-consistency": "fail",
      "restart-persistence": "fail"
    });
    expect(exitCode).toBe(1);
  }, 120_000);
});
