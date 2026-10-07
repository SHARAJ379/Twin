import { createServer, type Server } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { TwinError } from "../../domain/errors.js";
import * as portAllocator from "../process/portAllocator.js";
import { HttpProxy } from "./httpProxy.js";

function listenOnFreePort(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ server, port });
    });
  });
}

describe("HttpProxy under a port-allocation race", () => {
  it("rejects with E_PORT_UNAVAILABLE instead of hanging when the allocated port is already taken", async () => {
    const { server: blocker, port: takenPort } = await listenOnFreePort();
    const spy = vi.spyOn(portAllocator, "getFreePort").mockResolvedValueOnce(takenPort);

    try {
      const proxy = new HttpProxy();
      const err = await proxy.start(() => []).catch((e: unknown) => e);
      expect(TwinError.isTwinError(err)).toBe(true);
      expect((err as TwinError).code).toBe("E_PORT_UNAVAILABLE");
    } finally {
      spy.mockRestore();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
