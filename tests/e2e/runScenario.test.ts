import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseScenarioYaml } from "../../src/domain/scenarioParser.js";
import type { StepResult } from "../../src/domain/stepResult.js";
import { ConsoleLogger } from "../../src/infra/log/consoleLogger.js";
import { HttpScenarioClient } from "../../src/infra/http/httpScenarioClient.js";
import { ProcessInstanceDriver } from "../../src/infra/process/processInstanceDriver.js";
import { HttpProxy } from "../../src/infra/proxy/httpProxy.js";
import { FsWorkspaceManager } from "../../src/infra/workspace/fsWorkspaceManager.js";
import type { InstanceHandle, StartSpec, WorkspaceSpec } from "../../src/ports/instanceDriver.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const brokenExpressDir = path.resolve(here, "../../examples/broken-express");

// Same step shapes as TWIN_CONTEXT.md §7's example flow (signup -> login ->
// create an item on A -> read it back on B -> restart A -> read again),
// written with the explicit `kind:` discriminant TWIN_ARCHITECTURE.md's
// domain model requires (that doc wins where the two disagree).
const scenarioYaml = `
name: basic-user-flow
version: 1
steps:
  - id: signup
    kind: request
    request: { method: POST, path: /signup, json: { email: "a-{{unique}}@test.com", password: "pw12345" } }
    expect: { status: [200, 201] }
    save: { email: "$.email" }
  - id: login
    kind: request
    via: A
    request: { method: POST, path: /login, json: { email: "{{email}}", password: "pw12345" } }
    expect: { status: 200 }
  - id: create-item
    kind: request
    via: A
    request: { method: POST, path: /items, json: { name: "test-item" } }
    expect: { status: 201 }
    save: { itemId: "$.id" }
  - id: read-item-other-instance
    kind: request
    via: B
    request: { method: GET, path: "/items/{{itemId}}" }
    expect: { status: 200, bodyContains: "test-item" }
    check: data-consistency
  - id: restart-a
    kind: restart
    instance: A
  - id: read-after-restart
    kind: request
    via: A
    request: { method: GET, path: "/items/{{itemId}}" }
    expect: { status: 200 }
    check: restart-persistence
`;

function find(results: StepResult[], stepId: string): StepResult {
  const result = results.find((r) => r.stepId === stepId);
  if (result === undefined) throw new Error(`no result for step "${stepId}"`);
  return result;
}

/**
 * Milestone 3 acceptance test (TWIN_ARCHITECTURE.md §16.3): the scenario
 * engine runs the example flow against a real app through the real proxy -
 * and, run against the deliberately broken app, it surfaces exactly the two
 * bugs checks 2 and 4 exist to catch (without judging pass/fail yet - that's
 * milestone 4's Check layer).
 */
describe("scenario engine runs the example flow against examples/broken-express", () => {
  let root: string;
  let driver: ProcessInstanceDriver;
  let proxy: HttpProxy;
  let proxyUrl: string;
  const handles: InstanceHandle[] = [];

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "twin-scenario-e2e-"));
    driver = new ProcessInstanceDriver(new FsWorkspaceManager(root), new ConsoleLogger({ level: "error" }));

    const startSpec: StartSpec = { command: "npm start", portEnv: "PORT", env: {}, healthPath: "/health", bootTimeoutMs: 15_000 };
    const specFor = (instance: string): WorkspaceSpec => ({ instance, sourceDir: brokenExpressDir, link: ["node_modules"], ignore: [] });

    for (const instance of ["A", "B"]) {
      const ws = await driver.prepare(specFor(instance));
      handles.push(await driver.start(ws, startSpec));
    }

    proxy = new HttpProxy();
    const started = await proxy.start(() => handles);
    proxyUrl = started.url;
  }, 30_000);

  afterAll(async () => {
    await proxy.stop();
    for (const handle of handles) await driver.stop(handle, { graceMs: 2000 });
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 15_000);

  it("parses, runs, and demonstrates the exact bugs checks 2 and 4 exist to catch", async () => {
    const parsed = parseScenarioYaml(scenarioYaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const client = new HttpScenarioClient();
    const results = await client.run(parsed.scenario, {
      proxyUrl,
      instanceDriver: driver,
      instances: handles
    });

    expect(find(results, "signup").expectationsPassed).toBe(true);
    expect(find(results, "login").expectationsPassed).toBe(true);
    expect(find(results, "login").instanceServed).toBe("A");

    const createItem = find(results, "create-item");
    expect(createItem.expectationsPassed).toBe(true);
    expect(createItem.saved).toMatchObject({ itemId: expect.any(String) });

    // The bug data-consistency exists to catch - in broken-express it shows up
    // even earlier than "item not found": the in-memory *session* from A
    // doesn't exist on B either, so the request never gets past auth.
    const crossInstanceRead = find(results, "read-item-other-instance");
    expect(crossInstanceRead.instanceServed).toBe("B");
    expect(crossInstanceRead.response?.status).toBe(401);
    expect(crossInstanceRead.expectationsPassed).toBe(false);

    expect(find(results, "restart-a").expectationsPassed).toBe(true);

    // The bug restart-persistence exists to catch: restarting A wipes its
    // in-memory state entirely - including the session, so this also 401s
    // rather than getting as far as a 404 on the item itself.
    const afterRestart = find(results, "read-after-restart");
    expect(afterRestart.instanceServed).toBe("A");
    expect(afterRestart.response?.status).toBe(401);
    expect(afterRestart.expectationsPassed).toBe(false);
  });
});
