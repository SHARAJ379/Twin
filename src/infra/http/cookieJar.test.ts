import { describe, expect, it } from "vitest";

import { CookieJar } from "./cookieJar.js";

describe("CookieJar", () => {
  it("sends back what it ingested from Set-Cookie", () => {
    const jar = new CookieJar();
    jar.ingest("default", ["sid=abc123; Path=/; HttpOnly"]);
    expect(jar.headerFor("default", "/me")).toBe("sid=abc123");
  });

  it("keeps separate jars per client", () => {
    const jar = new CookieJar();
    jar.ingest("alice", ["sid=aaa; Path=/"]);
    jar.ingest("bob", ["sid=bbb; Path=/"]);
    expect(jar.headerFor("alice", "/me")).toBe("sid=aaa");
    expect(jar.headerFor("bob", "/me")).toBe("sid=bbb");
  });

  it("only sends a cookie for paths under its Path attribute", () => {
    const jar = new CookieJar();
    jar.ingest("default", ["scoped=x; Path=/admin"]);
    expect(jar.headerFor("default", "/admin/users")).toBe("scoped=x");
    expect(jar.headerFor("default", "/public")).toBeUndefined();
  });

  it("defaults Path to / when not specified", () => {
    const jar = new CookieJar();
    jar.ingest("default", ["sid=abc"]);
    expect(jar.headerFor("default", "/anything/deep")).toBe("sid=abc");
  });

  it("sends multiple applicable cookies joined with '; '", () => {
    const jar = new CookieJar();
    jar.ingest("default", ["a=1; Path=/", "b=2; Path=/"]);
    const header = jar.headerFor("default", "/x");
    expect(header).toContain("a=1");
    expect(header).toContain("b=2");
  });

  it("expires a cookie via Max-Age<=0 immediately", () => {
    const jar = new CookieJar();
    jar.ingest("default", ["sid=abc; Path=/"]);
    jar.ingest("default", ["sid=deleted; Path=/; Max-Age=0"]);
    expect(jar.headerFor("default", "/")).toBeUndefined();
  });

  it("returns undefined for a client that never received any cookies", () => {
    const jar = new CookieJar();
    expect(jar.headerFor("ghost", "/")).toBeUndefined();
  });
});
