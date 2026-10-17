import { describe, expect, it } from "vitest";

import { describeLostData } from "./responseDivergence.js";
import type { RedactedResponse } from "./stepResult.js";

const res = (status: number, body?: string): RedactedResponse => ({ status, headers: {}, bodyPreview: body });

describe("describeLostData", () => {
  /** The audited case: logged out answers 200 with a null user, and expect: only asked for 200. */
  it("reports a field the single instance returned and the split run nulled", () => {
    const lost = describeLostData(res(200, '{"user":"alice"}'), res(200, '{"user":null}'));
    expect(lost).toBe('$.user was "alice" on a single instance, but null across instances');
  });

  it("reports missing, empty-string, empty-array and empty-object fields, nested", () => {
    expect(describeLostData(res(200, '{"a":{"b":1}}'), res(200, '{"a":{}}'))).toContain("$.a was");
    expect(describeLostData(res(200, '{"items":[1]}'), res(200, '{"items":[]}'))).toContain("$.items");
    expect(describeLostData(res(200, '{"name":"x","id":"1"}'), res(200, '{"id":"2"}'))).toContain("$.name");
    expect(describeLostData(res(200, '{"name":"x"}'), res(200, '{"name":""}'))).toContain("$.name");
  });

  it("reports a different status, and an empty body where there was one", () => {
    expect(describeLostData(res(200, "{}"), res(204))).toContain("status 204");
    expect(describeLostData(res(200, "hello"), res(200, ""))).toContain("empty");
  });

  it("ignores values that merely differ - ids, timestamps, emails differ between any two runs", () => {
    expect(describeLostData(res(201, '{"id":"1","at":"t1","email":"a-1@x"}'), res(201, '{"id":"9","at":"t2","email":"a-2@x"}'))).toBeUndefined();
    expect(describeLostData(res(200, '{"count":3,"ok":true}'), res(200, '{"count":0,"ok":false}'))).toBeUndefined();
    expect(describeLostData(res(200, '{"items":[1,2,3]}'), res(200, '{"items":[4]}'))).toBeUndefined();
  });

  it("never compares a truncated or non-JSON body field by field", () => {
    expect(describeLostData(res(200, '{"user":"alice","x":"<truncated>'), res(200, '{"user":null}'))).toBeUndefined();
    expect(describeLostData(res(200, "<html>alice</html>"), res(200, "<html></html>"))).toBeUndefined();
  });

  it("never quotes a secret the control run returned", () => {
    const lost = describeLostData(res(200, '{"token":"abc"}'), res(200, '{"token":null}'));
    expect(lost).not.toContain("abc");
  });
});
