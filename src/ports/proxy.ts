import type { InstanceHandle } from "./instanceDriver.js";

export interface ProxyEvent {
  id: string;
  instance: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

/**
 * Our own tiny HTTP proxy (TWIN_ARCHITECTURE.md §7.2) - not nginx/HAProxy,
 * because checks need pinning, per-instance agents, and a per-request event
 * ledger that an off-the-shelf proxy won't give us (ADR #3).
 */
export interface Proxy {
  /** `instances` is read live on every request - restarts change who's eligible without restarting the proxy. */
  start(instances: () => InstanceHandle[]): Promise<{ url: string }>;
  stop(): Promise<void>;
  events(): AsyncIterable<ProxyEvent>;
}
