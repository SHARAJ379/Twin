import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCommand } from "../../src/cli/commands/run.js";
import { ConsoleLogger } from "../../src/infra/log/consoleLogger.js";
import { runtimeMissing } from "./helpers/fixtureRequirements.js";

const logger = new ConsoleLogger({ level: "error" });

// Flask signs its session cookie with secret_key, which falls back to a random
// one per process when SECRET_KEY isn't set - as it isn't under Twin.
const APP = `import os
from flask import Flask, jsonify, request, session

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY") or os.urandom(24)
items = {}


@app.get("/health")
def health():
    return jsonify(ok=True)


@app.post("/login")
def login():
    session["user"] = request.get_json()["name"]
    return jsonify(ok=True)


@app.get("/me")
def me():
    if "user" not in session:
        return jsonify(error="not logged in"), 401
    return jsonify(user=session["user"])


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ["PORT"]))
`;

const SCENARIO = `name: flask-login
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
`;

const flaskMissing = runtimeMissing("Flask", 'python -c "import flask"');

/**
 * Found by testing the packed tarball: this app's session failure was blamed
 * on `items = {}`, because the random-secret rule only knew the bare
 * `secret_key = os.urandom(24)` form, not the env-or-random fallback.
 */
describe.skipIf(flaskMissing)("a Flask app whose secret key is random per process", () => {
  let projectDir: string;

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("blames the secret_key line for the session failure, not the data container", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "flask-fixture-"));
    await writeFile(path.join(projectDir, "app.py"), APP, "utf8");
    await writeFile(path.join(projectDir, "requirements.txt"), "flask\n", "utf8");
    await writeFile(path.join(projectDir, "scenario.yaml"), SCENARIO, "utf8");

    const exitCode = await runCommand(
      {
        projectDir,
        scenarioPath: path.join(projectDir, "scenario.yaml"),
        env: {},
        start: "python app.py",
        bootTimeoutMs: 60_000,
        keepWorkspaces: false,
        allowRemote: false
      },
      logger
    );

    const latest = await readFile(path.join(projectDir, ".twin", "latest"), "utf8");
    const report = JSON.parse(await readFile(path.join(projectDir, ".twin", "runs", latest, "report.json"), "utf8")) as {
      findings: { checkId: string; status: string; suspects: { line: number; snippet: string }[] }[];
    };
    const session = report.findings.find((f) => f.checkId === "session-survives-switch")!;
    expect(session.status).toBe("fail");
    expect(session.suspects[0]).toMatchObject({ line: 5, snippet: 'app.secret_key = os.environ.get("SECRET_KEY") or os.urandom(24)' });
    expect(session.suspects.some((s) => s.snippet.startsWith("items"))).toBe(false);
    expect(exitCode).toBe(1);
  }, 150_000);
});
