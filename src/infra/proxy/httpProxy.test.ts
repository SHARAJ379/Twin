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
});
