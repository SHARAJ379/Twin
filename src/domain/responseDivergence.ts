import { redactValueForMessage } from "./redaction.js";
import type { RedactedResponse } from "./stepResult.js";

/**
 * What the split run's response is missing that the control run's had, for
 * the same step - or nothing, if it isn't missing anything.
 *
 * A check used to judge only the scenario's own `expect:`, so an app that
 * keeps sessions in memory and answers a logged-out `/me` with
 * `200 {"user": null}` passed a scenario expecting `status: 200`: control
 * returned `{"user":"alice"}`, the split run `{"user":null}`, both were on
 * disk in results.json, and Twin said the app looked safe. "Shows you where
 * they disagree" has to mean the responses, not just the user's assertions.
 *
 * Deliberately narrow, because two runs legitimately differ - ids,
 * timestamps, unique emails. Only a value the control run *had* and the split
 * run lost counts: present and non-empty on one instance, then null, empty or
 * missing across two. Values are never compared for equality.
 */
export function describeLostData(control: RedactedResponse | undefined, split: RedactedResponse | undefined): string | undefined {
  if (control === undefined || split === undefined) return undefined;

  if (control.status !== split.status) {
    return `the response was status ${split.status} across instances, but ${control.status} on a single instance`;
  }

  const controlBody = control.bodyPreview ?? "";
  const splitBody = split.bodyPreview ?? "";
  if (controlBody.trim().length > 0 && splitBody.trim().length === 0) {
    return "the response body was empty across instances, but not on a single instance";
  }

  const controlJson = parseWhole(controlBody);
  const splitJson = parseWhole(splitBody);
  if (controlJson === NOT_JSON || splitJson === NOT_JSON) return undefined;

  const lost = lostPaths(controlJson, splitJson, "$");
  if (lost.length === 0) return undefined;
  const first = lost[0]!;
  const more = lost.length > 1 ? ` (and ${lost.length - 1} more field${lost.length === 2 ? "" : "s"})` : "";
  return `${first.path} was ${redactValueForMessage(first.control, first.path)} on a single instance, but ${
    first.split === undefined ? "missing" : JSON.stringify(first.split)
  } across instances${more}`;
}

const NOT_JSON = Symbol("not-json");

/** A truncated preview isn't valid JSON, and a half-compared body would invent losses - so it isn't compared. */
function parseWhole(body: string): unknown {
  if (body.trim().length === 0 || body.endsWith("<truncated>")) return NOT_JSON;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return NOT_JSON;
  }
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false; // numbers and booleans are values, including 0 and false
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface Lost {
  path: string;
  control: unknown;
  split: unknown;
}

function lostPaths(control: unknown, split: unknown, at: string): Lost[] {
  if (isEmpty(control)) return [];
  if (isEmpty(split)) return [{ path: at, control, split }];
  // Arrays are compared for emptiness only: element order and count can
  // legitimately differ, and pairing elements up would be a guess.
  if (!isPlainObject(control) || !isPlainObject(split)) return [];

  const out: Lost[] = [];
  for (const [key, value] of Object.entries(control)) {
    const path = /^[A-Za-z_$][\w$]*$/.test(key) ? `${at}.${key}` : `${at}[${JSON.stringify(key)}]`;
    out.push(...lostPaths(value, split[key], path));
  }
  return out;
}
