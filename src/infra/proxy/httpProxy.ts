import { randomUUID } from "node:crypto";
import { EventEmitter, on } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

import { TwinError } from "../../domain/errors.js";
import type { InstanceHandle } from "../../ports/instanceDriver.js";
import type { Proxy, ProxyEvent } from "../../ports/proxy.js";
import { getFreePort } from "../process/portAllocator.js";

/** Shared with infra/http/httpScenarioClient.ts, which is the one sending this header. */
export const PIN_HEADER = "x-twin-pin";
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export interface HttpProxyOptions {
  /** How long a pinned request waits for its instance to become ready before 503ing. */
  readyTimeoutMs?: number;
}

function filteredHeaders(
  headers: IncomingMessage["headers"],
  extraDrop: string[] = []
): Record<string, string | string[]> {
  const drop = new Set([...HOP_BY_HOP, ...extraDrop]);
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || drop.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Own tiny node:http proxy (§7.2, ADR #3) - off-the-shelf proxies don't give
 * us per-request pinning, per-instance agents, or an evidence-ledger event
 * stream. Round-robin uses a single counter across all requests (not
 * per-connection), so alternation doesn't depend on keep-alive reuse.
 */
export class HttpProxy implements Proxy {
  private readonly emitter = new EventEmitter();
  private readonly agents = new Map<string, { agent: http.Agent; port: number }>();
  private readonly readyTimeoutMs: number;
  private server: http.Server | undefined;
  private rrCounter = 0;
  private getInstances: () => InstanceHandle[] = () => [];

  constructor(options: HttpProxyOptions = {}) {
    this.readyTimeoutMs = options.readyTimeoutMs ?? 5000;
  }

  async start(instances: () => InstanceHandle[]): Promise<{ url: string }> {
    this.getInstances = instances;
    const port = await getFreePort();
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(502);
        res.end(`proxy error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    // Never hang on WebSocket/upgrade requests - v1 doesn't support them (§7.2).
    this.server.on("upgrade", (_req, socket) => {
      socket.write("HTTP/1.1 501 Not Implemented\r\nX-Twin-Error: upgrade-not-supported\r\n\r\n");
      socket.destroy();
    });

    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.off("listening", onListening);
        reject(
          err.code === "EADDRINUSE"
            ? new TwinError("E_PORT_UNAVAILABLE", `Twin's proxy could not bind port ${port} - something else grabbed it first.`, {
                hint: "Re-run `twin run` - this is a rare timing race (Twin frees the port right before binding it) and should succeed on retry.",
                cause: err
              })
            : err
        );
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
    return { url: `http://127.0.0.1:${port}` };
  }

  async stop(): Promise<void> {
    for (const { agent } of this.agents.values()) agent.destroy();
    this.agents.clear();
    const server = this.server;
    if (server === undefined) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  events(): AsyncIterable<ProxyEvent> {
    const iterator = on(this.emitter, "event");
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const { value, done } = await iterator.next();
            return done === true ? { value: undefined, done: true as const } : { value: value[0] as ProxyEvent, done: false as const };
          }
        };
      }
    };
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const pin = req.headers[PIN_HEADER];
    const pinned = Array.isArray(pin) ? pin[0] : pin;

    const target = await this.pickTarget(pinned);
    if (target === undefined) {
      res.writeHead(503, { "X-Twin-Error": pinned !== undefined ? "pinned-instance-not-ready" : "no-ready-instance" });
      res.end();
      this.emit(method, url, undefined, 503, startedAt);
      return;
    }

    const agent = this.agentFor(target);
    const upstreamUrl = new URL(url, target.baseUrl);

    const proxyReq = http.request(
      upstreamUrl,
      {
        method,
        agent,
        headers: {
          ...filteredHeaders(req.headers, [PIN_HEADER]),
          host: req.headers.host ?? upstreamUrl.host, // preserve the ORIGINAL Host - apps check Origin/CSRF against it
          "x-forwarded-for": req.socket.remoteAddress ?? "",
          "x-forwarded-proto": "http",
          "x-forwarded-host": req.headers.host ?? ""
        }
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, {
          ...filteredHeaders(proxyRes.headers),
          "X-Twin-Instance": target.id
        });
        proxyRes.pipe(res);
        proxyRes.on("end", () => this.emit(method, url, target, proxyRes.statusCode ?? 502, startedAt));
      }
    );
    proxyReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "X-Twin-Instance": target.id });
      res.end();
      this.emit(method, url, target, 502, startedAt);
    });
    req.pipe(proxyReq);
  }

  private async pickTarget(pinned: string | undefined): Promise<InstanceHandle | undefined> {
    if (pinned !== undefined) {
      const deadline = Date.now() + this.readyTimeoutMs;
      let found = this.readyInstance(pinned);
      while (found === undefined && Date.now() < deadline) {
        await sleep(100);
        found = this.readyInstance(pinned);
      }
      return found;
    }

    const ready = this.getInstances().filter((i) => i.state === "ready");
    if (ready.length === 0) return undefined;
    const idx = this.rrCounter % ready.length;
    this.rrCounter++;
    return ready[idx];
  }

  private readyInstance(id: string): InstanceHandle | undefined {
    return this.getInstances().find((i) => i.id === id && i.state === "ready");
  }

  private agentFor(target: InstanceHandle): http.Agent {
    const existing = this.agents.get(target.id);
    const port = Number(new URL(target.baseUrl).port);
    if (existing !== undefined && existing.port === port) return existing.agent;
    existing?.agent.destroy();
    const agent = new http.Agent({ keepAlive: true });
    this.agents.set(target.id, { agent, port });
    return agent;
  }

  private emit(method: string, path: string, target: InstanceHandle | undefined, status: number, startedAt: number): void {
    const event: ProxyEvent = {
      id: randomUUID(),
      instance: target?.id ?? "",
      method,
      path,
      status,
      durationMs: Date.now() - startedAt
    };
    this.emitter.emit("event", event);
  }
}
