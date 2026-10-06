import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { InstanceHandle, StartSpec, WorkspaceSpec } from "../../src/ports/instanceDriver.js";
import { ConsoleLogger } from "../../src/infra/log/consoleLogger.js";
import { isProcessAlive } from "../../src/infra/process/isProcessAlive.js";
import { ProcessInstanceDriver } from "../../src/infra/process/processInstanceDriver.js";
import { HttpProxy } from "../../src/infra/proxy/httpProxy.js";
import { FsWorkspaceManager } from "../../src/infra/workspace/fsWorkspaceManager.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const brokenExpressDir = path.resolve(here, "../../examples/broken-express");

/**
 * Milestone 2 acceptance test (TWIN_ARCHITECTURE.md §16.2): boot A and B of
 * a real app, round-robin/pin through our real proxy, and leave no orphan
 * processes behind.
 */
describe("twin boots two real instances and proxies between them", () => {
  let root: string;
  let driver: ProcessInstanceDriver;
  let proxy: HttpProxy;
  let handles: InstanceHandle[] = [];
  let proxyUrl: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "twin-e2e-"));
    driver = new ProcessInstanceDriver(new FsWorkspaceManager(root), new ConsoleLogger({ level: "error" }));

    const startSpec: StartSpec = {
      command: "npm start",
      portEnv: "PORT",
      env: {},
      healthPath: "/health",
      bootTimeoutMs: 15_000
    };
    const specFor = (instance: string): WorkspaceSpec => ({
      instance,
      sourceDir: brokenExpressDir,
      link: ["node_modules"],
      ignore: []
    });

    for (const instance of ["A", "B"]) {
      const ws = await driver.prepare(specFor(instance));
      const handle = await driver.start(ws, startSpec);
      handles.push(handle);
    }

    proxy = new HttpProxy();
    const started = await proxy.start(() => handles);
    proxyUrl = started.url;
  }, 30_000);

  afterAll(async () => {
    await proxy.stop();
    for (const handle of handles) {
      await driver.stop(handle, { graceMs: 2000 });
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 15_000);

  it("alternates A/B through the proxy with no sticky sessions", async () => {
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${proxyUrl}/health`);
      seen.push(res.headers.get("x-twin-instance") ?? "?");
    }
    expect(seen).toEqual(["A", "B", "A", "B"]);
  });

  it("demonstrates the bug this whole project exists to catch: login on A is invisible to B", async () => {
    const loginRes = await fetch(`${proxyUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Twin-Pin": "A" },
      body: JSON.stringify({ email: "a@test.com", password: "pw12345" })
    });
    const cookie = loginRes.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeDefined();

    const meOnB = await fetch(`${proxyUrl}/me`, {
      headers: { "X-Twin-Pin": "B", Cookie: cookie! }
    });
    expect(meOnB.status).toBe(401); // in-memory session on A doesn't exist on B
  });

  it("leaves no orphan processes after stop()", async () => {
    for (const handle of handles) {
      await driver.stop(handle, { graceMs: 2000 });
    }
    for (const handle of handles) {
      expect(isProcessAlive(handle.pid!)).toBe(false);
    }
    handles = []; // afterAll's stop() loop becomes a no-op; already stopped here
  });
});
