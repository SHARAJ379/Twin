import http from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { InstanceHandle } from "../../ports/instanceDriver.js";
import { HttpProxy } from "./httpProxy.js";

/** A tiny fake upstream that echoes its own id and the request it received. */
function startFakeUpstream(id: string): Promise<{ server: http.Server; baseUrl: string; requests: http.IncomingMessage[] }> {
  const requests: http.IncomingMessage[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req);
    res.writeHead(200, { "content-type": "application/json", connection: "keep-alive" });
    res.end(JSON.stringify({ id, url: req.url, host: req.headers.host }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, requests });
    });
  });
}

describe("HttpProxy", () => {
  let upstreamA: Awaited<ReturnType<typeof startFakeUpstream>>;
  let upstreamB: Awaited<ReturnType<typeof startFakeUpstream>>;
  let proxy: HttpProxy;
  let proxyUrl: string;
  let instances: InstanceHandle[];

  beforeEach(async () => {
    upstreamA = await startFakeUpstream("A");
    upstreamB = await startFakeUpstream("B");
    instances = [
      { id: "A", baseUrl: upstreamA.baseUrl, state: "ready" },
      { id: "B", baseUrl: upstreamB.baseUrl, state: "ready" }
    ];
    proxy = new HttpProxy({ readyTimeoutMs: 300 });
    const started = await proxy.start(() => instances);
    proxyUrl = started.url;
  });

  afterEach(async () => {
    await proxy.stop();
    await new Promise((resolve) => upstreamA.server.close(resolve));
    await new Promise((resolve) => upstreamB.server.close(resolve));
  });

  it("alternates between instances round-robin, independent of connection reuse", async () => {
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${proxyUrl}/items`);
      const body = (await res.json()) as { id: string };
      seen.push(body.id);
    }
    expect(seen).toEqual(["A", "B", "A", "B"]);
  });

  it("pins to a specific instance via X-Twin-Pin, and strips that header before forwarding", async () => {
    const res = await fetch(`${proxyUrl}/me`, { headers: { "X-Twin-Pin": "B" } });
    expect(res.headers.get("x-twin-instance")).toBe("B");
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("B");

    const forwarded = upstreamB.requests.at(-1);
    expect(forwarded?.headers["x-twin-pin"]).toBeUndefined();
  });

  it("preserves the original Host header when forwarding", async () => {
    // fetch() treats Host as a forbidden header and silently drops it, so
    // this needs node:http directly to actually send a custom Host.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request(
        `${proxyUrl}/me`,
        { headers: { "X-Twin-Pin": "A", Host: "myapp.example" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        }
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
    const forwarded = upstreamA.requests.at(-1);
    expect(forwarded?.headers.host).toBe("myapp.example");
  });

  it("503s with X-Twin-Error when the pinned instance never becomes ready", async () => {
    const res = await fetch(`${proxyUrl}/me`, { headers: { "X-Twin-Pin": "C" } });
    expect(res.status).toBe(503);
    expect(res.headers.get("x-twin-error")).toBe("pinned-instance-not-ready");
  });

  it("503s with X-Twin-Error when there are no ready instances at all", async () => {
    instances = [
      { id: "A", baseUrl: upstreamA.baseUrl, state: "down" },
      { id: "B", baseUrl: upstreamB.baseUrl, state: "restarting" }
    ];
    const res = await fetch(`${proxyUrl}/me`);
    expect(res.status).toBe(503);
    expect(res.headers.get("x-twin-error")).toBe("no-ready-instance");
  });

  it("returns 501 and never hangs on an upgrade (WebSocket) request", async () => {
    const response = await new Promise<string>((resolve, reject) => {
      const req = http.request(proxyUrl, { headers: { Connection: "Upgrade", Upgrade: "websocket" } });
      req.on("upgrade", (res, socket) => {
        let data = "";
        socket.on("data", (chunk) => (data += chunk.toString()));
        socket.on("end", () => resolve(`${res.statusCode}`));
      });
      req.on("response", (res) => resolve(`${res.statusCode}`));
      req.on("error", reject);
      req.end();
      setTimeout(() => reject(new Error("timed out waiting for upgrade response")), 2000);
    });
    expect(response).toBe("501");
  });

  it("504s a request its instance never answers, rather than holding the socket open", async () => {
    // A dedicated proxy: a hung upstream is only interesting against a short
    // upstream deadline, and the shared one in beforeEach uses the default.
    const hung = http.createServer(() => {
      /* accepts the connection, never responds */
    });
    await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", () => resolve()));
    const address = hung.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const timeoutProxy = new HttpProxy({ upstreamTimeoutMs: 300 });
    const started = await timeoutProxy.start(() => [
      { id: "A", baseUrl: `http://127.0.0.1:${port}`, state: "ready" }
    ]);

    try {
      const res = await fetch(`${started.url}/slow`, { signal: AbortSignal.timeout(5000) });
      expect(res.status).toBe(504);
      expect(res.headers.get("x-twin-error")).toBe("upstream-timeout");
    } finally {
      await timeoutProxy.stop();
      hung.closeAllConnections();
      await new Promise((resolve) => hung.close(resolve));
    }
  });

  it("forwards a request body through to the instance", async () => {
    const received: string[] = [];
    const echo = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk.toString()));
      req.on("end", () => {
        received.push(body);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ length: body.length }));
      });
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", () => resolve()));
    const address = echo.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const proxyWithEcho = new HttpProxy();
    const started = await proxyWithEcho.start(() => [{ id: "A", baseUrl: `http://127.0.0.1:${port}`, state: "ready" }]);
    try {
      const res = await fetch(`${started.url}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test" })
      });
      expect(res.status).toBe(201);
      expect(received).toEqual(['{"name":"test"}']);
    } finally {
      await proxyWithEcho.stop();
      echo.closeAllConnections();
      await new Promise((resolve) => echo.close(resolve));
    }
  });

  it("streams a chunked response back whole, rather than truncating at the first chunk", async () => {
    const chunked = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("first-");
      res.write("second-");
      setTimeout(() => res.end("third"), 20);
    });
    await new Promise<void>((resolve) => chunked.listen(0, "127.0.0.1", () => resolve()));
    const address = chunked.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const streamProxy = new HttpProxy();
    const started = await streamProxy.start(() => [{ id: "A", baseUrl: `http://127.0.0.1:${port}`, state: "ready" }]);
    try {
      const res = await fetch(`${started.url}/stream`);
      expect(await res.text()).toBe("first-second-third");
    } finally {
      await streamProxy.stop();
      chunked.closeAllConnections();
      await new Promise((resolve) => chunked.close(resolve));
    }
  });

  it("preserves a redirect's status and Location instead of following it", async () => {
    const redirector = http.createServer((_req, res) => {
      res.writeHead(302, { location: "/elsewhere" });
      res.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", () => resolve()));
    const address = redirector.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const redirectProxy = new HttpProxy();
    const started = await redirectProxy.start(() => [{ id: "A", baseUrl: `http://127.0.0.1:${port}`, state: "ready" }]);
    try {
      // A session cookie set on a redirect is exactly the evidence a
      // session-survives-switch scenario depends on, so the proxy must not
      // swallow either half of it.
      const res = await fetch(`${started.url}/login`, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/elsewhere");
      expect(res.headers.get("x-twin-instance")).toBe("A");
    } finally {
      await redirectProxy.stop();
      redirector.closeAllConnections();
      await new Promise((resolve) => redirector.close(resolve));
    }
  });

  it("502s when the instance's port accepts nothing at all", async () => {
    // A port nothing listens on: the connection is refused rather than
    // timing out, which is a different branch from the 504 above.
    const deadProxy = new HttpProxy();
    const started = await deadProxy.start(() => [{ id: "A", baseUrl: "http://127.0.0.1:1", state: "ready" }]);
    try {
      const res = await fetch(`${started.url}/anything`);
      expect(res.status).toBe(502);
      expect(res.headers.get("x-twin-instance")).toBe("A");
    } finally {
      await deadProxy.stop();
    }
  });

  it("emits a ProxyEvent per request with instance, status, and timing", async () => {
    const events = proxy.events();
    const collected: unknown[] = [];
    const collecting = (async () => {
      for await (const event of events) {
        collected.push(event);
        if (collected.length >= 1) break;
      }
    })();

    await fetch(`${proxyUrl}/items`);
    await collecting;

    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({ method: "GET", path: "/items", status: 200 });
  });

  // `new URL(req.url, base)` drops the base when the request target names a
  // host, which made the proxy forward to any host a local client asked for.
  describe("never forwards anywhere but an instance", () => {
    let elsewhere: Awaited<ReturnType<typeof startFakeUpstream>>;

    beforeEach(async () => {
      elsewhere = await startFakeUpstream("elsewhere");
    });

    afterEach(async () => {
      await new Promise((resolve) => elsewhere.server.close(resolve));
    });

    function rawRequest(target: string): Promise<{ status: number; body: string }> {
      const { port } = new URL(proxyUrl);
      return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path: target, method: "GET", agent: false }, (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => (body += chunk.toString()));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end();
      });
    }

    it("refuses an absolute-form request target", async () => {
      const res = await rawRequest(`${elsewhere.baseUrl}/steal`);

      expect(res.status).toBe(400);
      expect(elsewhere.requests).toHaveLength(0);
    });

    it("sends a path that starts with // to the instance, as a path", async () => {
      const host = new URL(elsewhere.baseUrl).host;
      const res = await rawRequest(`//${host}/steal`);

      expect(elsewhere.requests).toHaveLength(0);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ url: `//${host}/steal` });
    });
  });
});
