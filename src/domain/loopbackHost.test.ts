import { describe, expect, it } from "vitest";

import { loopbackHostEnv } from "./loopbackHost.js";

describe("loopbackHostEnv", () => {
  it("sets HOST and BIND_ADDRESS to 127.0.0.1 when nothing set them", () => {
    expect(loopbackHostEnv({ PATH: "/usr/bin", PORT: "3000" }, false)).toEqual({ HOST: "127.0.0.1", BIND_ADDRESS: "127.0.0.1" });
  });

  it("leaves alone each one the user already set, whatever its value", () => {
    expect(loopbackHostEnv({ HOST: "0.0.0.0" }, false)).toEqual({ BIND_ADDRESS: "127.0.0.1" });
    expect(loopbackHostEnv({ BIND_ADDRESS: "::1" }, false)).toEqual({ HOST: "127.0.0.1" });
    expect(loopbackHostEnv({ HOST: "", BIND_ADDRESS: "localhost" }, false)).toEqual({});
  });

  it("doesn't count a variable that's declared but undefined as set", () => {
    expect(loopbackHostEnv({ HOST: undefined }, false)).toEqual({ HOST: "127.0.0.1", BIND_ADDRESS: "127.0.0.1" });
  });

  it("matches names case-insensitively where the environment is (Windows)", () => {
    expect(loopbackHostEnv({ Host: "0.0.0.0" }, true)).toEqual({ BIND_ADDRESS: "127.0.0.1" });
    // Case-sensitive elsewhere: `Host` is a different variable from `HOST` on Linux.
    expect(loopbackHostEnv({ Host: "0.0.0.0" }, false)).toEqual({ HOST: "127.0.0.1", BIND_ADDRESS: "127.0.0.1" });
  });
});
