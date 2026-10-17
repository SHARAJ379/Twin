import { describe, expect, it } from "vitest";

import { describeLostData, type RunHistory } from "./responseDivergence.js";
import { fingerprintStep } from "./responseFingerprint.js";
import type { StepResult } from "./stepResult.js";

/** Identity "hash": the logic under test is what's compared, not the hashing. */
const hash = (value: string): string => `h(${value})`;

function step(status: number, body: string, request: { path: string; body?: string } = { path: "/" }): StepResult {
  return {
    stepId: "s",
    startedAt: 0,
    durationMs: 1,
    expectationsPassed: true,
    failedExpectations: [],
    request: { method: "GET", path: request.path, headers: {}, bodyPreview: request.body },
    response: { status, headers: {}, bodyPreview: body.length > 2048 ? `${body.slice(0, 2048)}<truncated>` : body },
    fingerprint: fingerprintStep(request, body, hash)
  };
}

/** Both runs signed up as alice first, so "alice" is data the scenario established. */
const signedUpAsAlice: RunHistory = {
  control: [step(201, '{"ok":true}', { path: "/signup", body: '{"name":"alice"}' })],
  split: [step(201, '{"ok":true}', { path: "/signup", body: '{"name":"alice"}' })]
};

describe("describeLostData", () => {
  /** The original audited case: logged out answers 200 with a null user, and expect: only asked for 200. */
  it("reports a field the single instance returned and the split run nulled", () => {
    expect(describeLostData(step(200, '{"user":"alice"}'), step(200, '{"user":null}'))).toBe(
      '$.user was "alice" on a single instance, but null across instances'
    );
  });

  it("reports missing, empty-string, empty-array, empty-object and nulled-parent fields", () => {
    expect(describeLostData(step(200, '{"a":{"b":1}}'), step(200, '{"a":{}}'))).toContain("$.a was");
    expect(describeLostData(step(200, '{"items":[1]}'), step(200, '{"items":[]}'))).toContain("$.items");
    expect(describeLostData(step(200, '{"name":"x","id":"1"}'), step(200, '{"id":"2"}'))).toContain("$.name");
    expect(describeLostData(step(200, '{"name":"x"}'), step(200, '{"name":""}'))).toContain("$.name");
    expect(describeLostData(step(200, '{"user":{"name":"x","id":1}}'), step(200, '{"user":null}'))).toBe(
      '$.user was {"name":"x","id":1} on a single instance, but null across instances'
    );
  });

  it("reports a different status, and an emptied body", () => {
    expect(describeLostData(step(200, "{}"), step(204, ""))).toContain("status 204");
    expect(describeLostData(step(200, "hello"), step(200, ""))).toContain("empty");
  });

  /** Audit, second round: a logged-out flag is a boolean, and booleans were never compared. */
  it("reports true turning false - {authenticated: false}", () => {
    expect(describeLostData(step(200, '{"authenticated":true}'), step(200, '{"authenticated":false}'))).toBe(
      "$.authenticated was true on a single instance, but false across instances"
    );
    // ...but not the other way round, which loses nothing
    expect(describeLostData(step(200, '{"cached":false}'), step(200, '{"cached":true}'))).toBeUndefined();
  });

  it.each(["isLoggedIn", "logged_in", "hasSession", "valid", "ok", "success", "exists", "found", "isOwner", "authorized"])(
    "reports the state flag %s turning false",
    (key) => {
      expect(describeLostData(step(200, `{"${key}":true}`), step(200, `{"${key}":false}`))).toMatch(
        new RegExp(String.raw`^\$\.${key} was .* but false across instances$`)
      );
    }
  );

  // Audit, third round: a flag that legitimately differs per instance - a
  // per-process cache, a first-visit marker - is not lost data.
  it.each(["cached", "fromCache", "isFirstVisit", "warm", "cacheHit", "isNew"])("ignores %s turning false", (key) => {
    expect(describeLostData(step(200, `{"${key}":true}`), step(200, `{"${key}":false}`))).toBeUndefined();
  });

  /** Audit, second round: a fallback user isn't null, empty or missing - it's a different value. */
  it("reports a fallback replacing data the scenario established - {user: guest}", () => {
    expect(describeLostData(step(200, '{"user":"alice"}'), step(200, '{"user":"guest"}'), signedUpAsAlice)).toBe(
      '$.user was "alice" on a single instance, but "guest" - a value this run never sent or received across instances'
    );
  });

  it("ignores values that merely differ - generated ids, timestamps and unique emails", () => {
    const history: RunHistory = {
      control: [step(201, '{"id":"1"}', { path: "/signup", body: '{"email":"a-1@x"}' })],
      split: [step(201, '{"id":"9"}', { path: "/signup", body: '{"email":"a-2@x"}' })]
    };
    expect(
      describeLostData(
        step(200, '{"id":"1","email":"a-1@x","at":"t1"}', { path: "/items/1" }),
        step(200, '{"id":"9","email":"a-2@x","at":"t2"}', { path: "/items/9" }),
        history
      )
    ).toBeUndefined();
    expect(describeLostData(step(200, '{"count":3}'), step(200, '{"count":0}'))).toBeUndefined();
    expect(describeLostData(step(200, '{"items":[1,2,3]}'), step(200, '{"items":[4]}'))).toBeUndefined();
  });

  /** Audit, second round: previews are cut at 2KB, and a cut preview was never compared. */
  it("compares a response over 2KB in full", () => {
    const padding = "x".repeat(5000);
    expect(describeLostData(step(200, `{"user":"alice","pad":"${padding}"}`), step(200, `{"user":null,"pad":"${padding}"}`))).toBe(
      "$.user was a value on a single instance, but null across instances"
    );
  });

  it("never quotes a secret the control run returned", () => {
    const lost = describeLostData(step(200, '{"token":"abc"}'), step(200, '{"token":null}'));
    expect(lost).not.toContain("abc");
  });
});
