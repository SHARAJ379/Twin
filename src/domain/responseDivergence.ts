import { redactValueForMessage } from "./redaction.js";
import { fingerprintStep, type StepFingerprint } from "./responseFingerprint.js";
import type { RedactedResponse, StepResult } from "./stepResult.js";

/** Each run's steps before the assertion: what the scenario had sent and received by then. */
export interface RunHistory {
  control: StepResult[];
  split: StepResult[];
}

/**
 * What the split run's response is missing that the control run's had, for
 * the same step - or nothing, if it isn't missing anything.
 *
 * A check used to judge only the scenario's own `expect:`, so an app that
 * keeps sessions in memory and answers a logged-out `/me` with
 * `200 {"user": null}` passed a scenario expecting `status: 200`. "Shows you
 * where they disagree" has to mean the responses, not just the assertions.
 *
 * Two runs legitimately differ - ids, timestamps, unique emails - so values
 * are never simply compared for equality. A value counts as lost when the
 * control run had it and the split run:
 *
 * - has it null, empty or missing instead;
 * - has `false` where the control run had `true` (`{"authenticated": false}`);
 * - has a different string, where the control run's value was data the
 *   scenario itself established (sent, or received in an earlier step) and
 *   the split run's is something that run never sent or received - a
 *   fallback like `{"user": "guest"}` where control returned the user who
 *   signed up. An id or a timestamp the app generated was never "sent", so it
 *   is never held to this.
 */
export function describeLostData(control: StepResult, split: StepResult, history?: RunHistory): string | undefined {
  const c = control.response;
  const s = split.response;
  if (c === undefined || s === undefined) return undefined;

  if (c.status !== s.status) {
    return `the response was status ${s.status} across instances, but ${c.status} on a single instance`;
  }

  const cf = control.fingerprint ?? fingerprintFromPreview(control);
  const sf = split.fingerprint ?? fingerprintFromPreview(split);
  if (cf === undefined || sf === undefined) return undefined;

  if (cf.bodyLength > 0 && sf.bodyLength === 0) {
    return "the response body was empty across instances, but not on a single instance";
  }
  if (cf.leaves === undefined || sf.leaves === undefined) return undefined;

  const controlKnew = knownStrings(history?.control ?? [], cf);
  const splitKnew = knownStrings(history?.split ?? [], sf);
  const lost = lostLeaves(cf.leaves, sf.leaves, controlKnew, splitKnew);
  if (lost.length === 0) return undefined;

  const first = lost[0]!;
  const more = lost.length > 1 ? ` (and ${lost.length - 1} more field${lost.length === 2 ? "" : "s"})` : "";
  return `${first.path} was ${quote(c, first.path, first.control)} on a single instance, but ${describeSplit(s, first)} across instances${more}`;
}

interface LostLeaf {
  path: string;
  control: string;
  split: string | undefined;
  replaced: boolean;
}

const EMPTY_KINDS = new Set(["null", "empty"]);

function knownStrings(earlier: StepResult[], self: StepFingerprint): Set<string> {
  const known = new Set(self.sent);
  for (const step of earlier) {
    for (const h of step.fingerprint?.sent ?? []) known.add(h);
    for (const h of step.fingerprint?.received ?? []) known.add(h);
  }
  return known;
}

/** `$.user.name` -> ["$.user", "$"]. */
function ancestorsOf(path: string): string[] {
  const out: string[] = [];
  let at = path;
  for (;;) {
    const cut = Math.max(at.lastIndexOf("."), at.lastIndexOf("["));
    if (cut <= 0) break;
    at = at.slice(0, cut);
    out.push(at);
  }
  return out;
}

function lostLeaves(
  control: Record<string, string>,
  split: Record<string, string>,
  controlKnew: ReadonlySet<string>,
  splitKnew: ReadonlySet<string>
): LostLeaf[] {
  const out: LostLeaf[] = [];
  const reported = new Set<string>();
  for (const [path, c] of Object.entries(control)) {
    if (EMPTY_KINDS.has(c)) continue;
    const s = split[path];

    if (s === undefined) {
      // Gone because an ancestor came back null or empty: report the ancestor, once.
      const emptied = ancestorsOf(path).find((a) => split[a] !== undefined && EMPTY_KINDS.has(split[a]!));
      const at = emptied ?? path;
      if (!reported.has(at)) out.push({ path: at, control: c, split: emptied === undefined ? undefined : split[at], replaced: false });
      reported.add(at);
      continue;
    }
    if (EMPTY_KINDS.has(s) || (c === "true" && s === "false")) {
      out.push({ path, control: c, split: s, replaced: false });
      continue;
    }
    if (c.startsWith("s:") && s.startsWith("s:") && c !== s && controlKnew.has(c.slice(2)) && !splitKnew.has(s.slice(2))) {
      out.push({ path, control: c, split: s, replaced: true });
    }
  }
  return out;
}

/** The actual value from a body preview, when the preview still has it - otherwise its kind. */
function previewValue(response: RedactedResponse, path: string): { found: boolean; value: unknown } {
  const body = response.bodyPreview;
  if (body === undefined || body.endsWith("<truncated>")) return { found: false, value: undefined };
  let node: unknown;
  try {
    node = JSON.parse(body) as unknown;
  } catch {
    return { found: false, value: undefined };
  }
  for (const key of pathKeys(path)) {
    if (node === null || typeof node !== "object") return { found: false, value: undefined };
    node = (node as Record<string, unknown>)[key];
  }
  return { found: true, value: node };
}

function pathKeys(path: string): string[] {
  const keys: string[] = [];
  const re = /\.([A-Za-z_$][\w$]*)|\[("(?:[^"\\]|\\.)*")\]/g;
  for (const match of path.slice(1).matchAll(re)) keys.push(match[1] ?? (JSON.parse(match[2]!) as string));
  return keys;
}

function describeKind(kind: string): string {
  if (kind === "null") return "null";
  if (kind === "empty") return "empty";
  if (kind === "true" || kind === "false") return kind;
  if (kind === "number") return "a number";
  if (kind === "array") return "a non-empty list";
  return "a value";
}

function quote(response: RedactedResponse, path: string, kind: string): string {
  const preview = previewValue(response, path);
  return preview.found ? redactValueForMessage(preview.value, path) : describeKind(kind);
}

function describeSplit(response: RedactedResponse, lost: LostLeaf): string {
  if (lost.split === undefined) return "missing";
  if (lost.replaced) {
    const preview = previewValue(response, lost.path);
    const shown = preview.found ? redactValueForMessage(preview.value, lost.path) : "a different value";
    return `${shown} - a value this run never sent or received`;
  }
  return describeKind(lost.split);
}

/**
 * For a result captured without a fingerprint (a plugin's, or an older
 * results.json): built from the preview, which has no provenance - so only
 * the null/empty/boolean rules apply. A truncated preview is half a body,
 * and comparing half a body would invent losses, so it yields nothing.
 */
function fingerprintFromPreview(result: StepResult): StepFingerprint | undefined {
  const body = result.response?.bodyPreview ?? "";
  if (body.endsWith("<truncated>")) return undefined;
  return fingerprintStep({ path: result.request?.path ?? "" }, body, (value) => value);
}
