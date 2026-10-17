/**
 * What the response check needs to know about a step, captured from the full
 * request and response rather than from the 2KB body preview the report keeps.
 *
 * Comparing previews meant a response over 2KB was never compared at all - a
 * truncated preview isn't JSON - so `{"user": null, ...}` passed whenever the
 * body was big. And a check that only sees "null or not" can't tell
 * `{"user": "alice"}` from a fallback `{"user": "guest"}`.
 *
 * Values are never stored, only their kind and, for strings, a salted hash:
 * results.json promises to be safe to paste publicly, and an unsalted hash of
 * a short password is a lookup away from the password. The salt lives only in
 * this process, so the hashes compare within one `twin run` and nowhere else.
 */
export interface StepFingerprint {
  /** Length of the response body, in characters. */
  bodyLength: number;
  /**
   * JSON leaves of the response by path (`$.user.name`), outside arrays:
   * "null" | "empty" | "true" | "false" | "number" | "array" | "s:<hash>".
   * Absent when the body isn't JSON.
   */
  leaves?: Record<string, string>;
  /** Hashes of every string this step sent: body fields, form values, path segments, query values. */
  sent: string[];
  /** Hashes of every string in the response body, arrays included. */
  received: string[];
}

export type Hasher = (value: string) => string;

const MAX_LEAVES = 2000;
const MAX_STRINGS = 1000;

/** A string shorter than this is too common to say where it came from ("ok", "en", "1"). */
const MIN_PROVENANCE_LENGTH = 3;

function parseJson(text: string | undefined): unknown {
  if (text === undefined || text.trim().length === 0) return NOT_JSON;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return NOT_JSON;
  }
}

const NOT_JSON = Symbol("not-json");

function childPath(at: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${at}.${key}` : `${at}[${JSON.stringify(key)}]`;
}

function leavesOf(value: unknown, hash: Hasher): Record<string, string> {
  const out: Record<string, string> = {};
  let count = 0;
  const walk = (node: unknown, at: string): void => {
    if (count >= MAX_LEAVES) return;
    if (node === null || node === undefined) {
      out[at] = "null";
    } else if (typeof node === "boolean") {
      out[at] = node ? "true" : "false";
    } else if (typeof node === "number") {
      out[at] = "number";
    } else if (typeof node === "string") {
      out[at] = node.length === 0 ? "empty" : `s:${hash(node)}`;
    } else if (Array.isArray(node)) {
      // Element order and count can legitimately differ between two runs,
      // and pairing elements up would be a guess - so only emptiness.
      out[at] = node.length === 0 ? "empty" : "array";
    } else if (typeof node === "object") {
      const entries = Object.entries(node as Record<string, unknown>);
      if (entries.length === 0) out[at] = "empty";
      for (const [key, child] of entries) walk(child, childPath(at, key));
    }
    count++;
  };
  walk(value, "$");
  return out;
}

function stringsIn(value: unknown, into: Set<string>): void {
  if (into.size >= MAX_STRINGS) return;
  if (typeof value === "string") {
    if (value.length >= MIN_PROVENANCE_LENGTH) into.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) stringsIn(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) stringsIn(item, into);
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/** Every string a request carried, however it was encoded. */
function sentStrings(path: string, body: string | undefined): Set<string> {
  const out = new Set<string>();
  const [beforeQuery = "", query = ""] = path.split("#")[0]!.split("?", 2);
  for (const segment of beforeQuery.split("/")) stringsIn(safeDecode(segment), out);
  for (const pair of query.split("&")) stringsIn(safeDecode(pair.slice(pair.indexOf("=") + 1)), out);

  const json = parseJson(body);
  if (json !== NOT_JSON) {
    stringsIn(json, out);
  } else if (body !== undefined && /^[^\s=&]+=/.test(body)) {
    for (const pair of body.split("&")) stringsIn(safeDecode(pair.slice(pair.indexOf("=") + 1)), out);
  }
  return out;
}

export function fingerprintStep(
  request: { path: string; body?: string | undefined },
  responseBody: string,
  hash: Hasher
): StepFingerprint {
  const json = parseJson(responseBody);
  const received = new Set<string>();
  if (json !== NOT_JSON) stringsIn(json, received);
  return {
    bodyLength: responseBody.length,
    ...(json !== NOT_JSON ? { leaves: leavesOf(json, hash) } : {}),
    sent: [...sentStrings(request.path, request.body)].map(hash),
    received: [...received].map(hash)
  };
}
