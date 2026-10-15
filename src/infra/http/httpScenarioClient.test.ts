import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { Scenario } from "../../domain/scenario.js";
import type { InstanceDriver } from "../../ports/instanceDriver.js";
import { HttpScenarioClient } from "./httpScenarioClient.js";

/**
 * Nothing in these tests mocks fetch: the whole point is that a *real* socket
 * which never answers can no longer hang the run (it used to hang forever -
 * in CI, until the job's own timeout killed it).
 */
let server: http.Server | undefined;

afterEach(async () => {
  const running = server;
  server = undefined;
  if (running !== undefined) {
    running.closeAllConnections();
    await new Promise<void>((resolve) => running.close(() => resolve()));
  }
});

async function listen(handler: http.RequestListener): Promise<string> {
  const created = http.createServer(handler);
  server = created;
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(created.address() as AddressInfo).port}`;
}

const driver = {} as InstanceDriver; // never touched: these scenarios have no restart step

function oneStep(path = "/"): Scenario {
  return { name: "s", version: 1, steps: [{ kind: "request", id: "step", request: { method: "GET", path } }] };
}

describe("HttpScenarioClient request timeout", () => {
  it("fails the step instead of hanging when the app accepts the connection and never answers", async () => {
    const url = await listen(() => {
      /* deliberately never responds */
    });

    const started = Date.now();
    const [result] = await new HttpScenarioClient().run(oneStep(), {
      proxyUrl: url,
      instanceDriver: driver,
      instances: [],
      requestTimeoutMs: 300
    });

    expect(result?.expectationsPassed).toBe(false);
    expect(result?.error?.message).toContain("request timed out after 300ms");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("fails the step when the response body never ends, which text() alone would wait on forever", async () => {
    const url = await listen((_req, res) => {
      // An SSE-shaped response: headers and a first chunk arrive, so fetch()
      // itself resolves - the hang used to happen in the body read, which sat
      // outside the request's timeout and outside the try/catch.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
    });

    const [result] = await new HttpScenarioClient().run(oneStep(), {
      proxyUrl: url,
      instanceDriver: driver,
      instances: [],
      requestTimeoutMs: 300
    });

    expect(result?.expectationsPassed).toBe(false);
    expect(result?.error?.message).toContain("request timed out after 300ms");
  });

  it("names the flag to raise, since a slow app and a hung one look identical from here", async () => {
    const url = await listen(() => {
      /* never responds */
    });

    const [result] = await new HttpScenarioClient().run(oneStep(), {
      proxyUrl: url,
      instanceDriver: driver,
      instances: [],
      requestTimeoutMs: 200
    });

    expect(result?.error?.message).toContain("--request-timeout-ms");
  });

  it("honours redactExtraHeaders, the RunContext field nothing used to populate", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "x-api-token": "sk_live_abc123" });
      res.end("{}");
    });

    const [result] = await new HttpScenarioClient().run(oneStep(), {
      proxyUrl: url,
      instanceDriver: driver,
      instances: [],
      redactExtraHeaders: ["X-API-Token"] // matched case-insensitively, like every header
    });

    expect(result?.response?.headers["x-api-token"]).toBe("<redacted>");
    expect(JSON.stringify(result)).not.toContain("sk_live_abc123");
  });

  it("leaves a request that answers in time completely unaffected", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    const scenario: Scenario = {
      name: "s",
      version: 1,
      steps: [{ kind: "request", id: "step", request: { method: "GET", path: "/" }, expect: { status: 200 } }]
    };
    const [result] = await new HttpScenarioClient().run(scenario, {
      proxyUrl: url,
      instanceDriver: driver,
      instances: [],
      requestTimeoutMs: 5000
    });

    expect(result?.expectationsPassed).toBe(true);
    expect(result?.response?.status).toBe(200);
  });
});

describe("HttpScenarioClient cookie handling", () => {
  it("sends a path-scoped cookie on a later step whose path carries a query string", async () => {
    // The cookie jar matches Path= against the request path, so it has to be
    // given the *path*, not the raw scenario string: "/cart?coupon=X" never
    // path-matches Path=/cart, and the session cookie silently goes unsent -
    // which Twin would then report as a divergence the app never had.
    const sawCookie: (string | undefined)[] = [];
    const url = await listen((req, res) => {
      const path = req.url ?? "/";
      if (path.startsWith("/login")) {
        res.writeHead(200, { "set-cookie": "sid=abc123; Path=/cart" });
        res.end();
        return;
      }
      sawCookie.push(req.headers.cookie);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    const scenario: Scenario = {
      name: "s",
      version: 1,
      steps: [
        { kind: "request", id: "login", request: { method: "GET", path: "/login" } },
        { kind: "request", id: "cart", request: { method: "GET", path: "/cart?coupon=SAVE10" } }
      ]
    };
    await new HttpScenarioClient().run(scenario, {
      proxyUrl: url,
      instanceDriver: driver,
      instances: [],
      requestTimeoutMs: 5000
    });

    expect(sawCookie).toEqual(["sid=abc123"]);
  });
});
