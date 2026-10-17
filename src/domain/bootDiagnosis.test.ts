import { describe, expect, it } from "vitest";

import { portsAnnouncedInLog } from "./bootDiagnosis.js";

describe("portsAnnouncedInLog", () => {
  it.each([
    ["listening on port 3000", 3000],
    ["Server running at http://localhost:8080/", 8080],
    ["INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)", 8000],
    ["Listening on 0.0.0.0:4567", 4567],
    ["* Running on http://192.168.1.4:5000", 5000],
    ["[2026-10-17 12:00:00] PHP 8.3 Development Server (http://localhost:8001) started", 8001],
    ["Puma starting... * Listening on http://[::]:9292", 9292],
    ["App ready, port=3001", 3001]
  ])("finds the port in %j", (line, port) => {
    expect(portsAnnouncedInLog([line])).toEqual([port]);
  });

  it("ignores ports in lines that don't announce a server", () => {
    expect(portsAnnouncedInLog(["connecting to postgres://localhost:5432/app", "node v20.11.0", "GET /health 200"])).toEqual([]);
  });

  it("reports each port once", () => {
    expect(portsAnnouncedInLog(["listening on port 3000", "Server ready on http://localhost:3000"])).toEqual([3000]);
  });
});
