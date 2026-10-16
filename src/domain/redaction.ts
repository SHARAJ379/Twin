// Reports must be safe to paste publicly (§7.7) - this is the one place that
// decides what evidence is allowed to survive into a StepResult/report.

const HEADER_ALLOWLIST = new Set(["content-type", "content-length", "location", "x-twin-instance"]);
const SECRET_HEADER_NAMES = new Set(["authorization"]);
const MAX_BODY_CHARS = 2048;

/**
 * A field name is a secret if any *word* in it is one of these. Matching whole
 * words rather than substrings is what keeps both halves of the job honest:
 * an exact-name list misses every shape real APIs use (`access_token`,
 * `accessToken`, `refreshToken`, `apiKey`, `client_secret`), while a substring
 * list masks `author`, `keyword`, `monkey` and `tokenizer_version` - and the
 * body is evidence a human has to read, so over-redaction has a cost too.
 */
const SECRET_WORDS = new Set([
  "password",
  "passwd",
  "passphrase",
  "pwd",
  "secret",
  "token",
  "key",
  "auth",
  "authorization",
  "bearer",
  "credential",
  "credentials",
  "signature",
  "sig",
  "salt",
  "otp",
  "pin",
  "session",
  "jwt"
]);

/**
 * Names with no separator to split on, where the word above would be buried:
 * `accesstoken` has no boundary, and `token` can't be a substring rule without
 * taking `tokenizer` with it.
 */
const SECRET_KEY_SUBSTRINGS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "credential",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "accesskey",
  "privatekey",
  "signingkey",
  "sessionid",
  "authorization",
  "bearer",
  "signature"
];

/** Lowercased with separators removed, so api_key / API-KEY / apiKey are one thing. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** `X-Auth-Token` and `accessToken` both become ["x","auth","token"] / ["access","token"]. */
function wordsIn(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

function isSecretKey(key: string, extra: ReadonlySet<string>): boolean {
  const normalized = normalizeKey(key);
  if (normalized.length === 0) return false;
  if (extra.has(normalized)) return true;
  if (wordsIn(key).some((word) => SECRET_WORDS.has(word))) return true;
  return SECRET_KEY_SUBSTRINGS.some((needle) => normalized.includes(needle));
}

function redactSetCookie(value: string): string {
  // "sid=abc123; Path=/; HttpOnly" -> "sid=<redacted>; Path=/; HttpOnly" - only
  // the value of the first (name=value) segment is a secret; attributes aren't.
  const parts = value.split(";");
  const pair = parts[0] ?? "";
  const attrs = parts.slice(1);
  const eqIdx = pair.indexOf("=");
  const redactedPair = eqIdx === -1 ? pair : `${pair.slice(0, eqIdx)}=<redacted>`;
  return [redactedPair, ...attrs].join(";");
}

function redactCookieRequestHeader(value: string): string {
  // A request Cookie header is just "name=value; name2=value2", no attributes.
  return value
    .split(";")
    .map((part) => {
      const trimmed = part.trim();
      const eqIdx = trimmed.indexOf("=");
      return eqIdx === -1 ? trimmed : `${trimmed.slice(0, eqIdx)}=<redacted>`;
    })
    .join("; ");
}

/** Keeps only an allowlist of headers; cookies keep their names but never their values. */
export function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
  extraRedact: string[] = []
): Record<string, string> {
  const extra = new Set(extraRedact.map((h) => h.toLowerCase()));
  const out: Record<string, string> = {};

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) continue;
    const key = rawKey.toLowerCase();
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;

    if (key === "set-cookie") {
      // Each cookie redacted on its own: a response can set several, and
      // joining them first would hand redactSetCookie one string whose later
      // name=value pairs look like attributes of the first cookie.
      const cookies = Array.isArray(rawValue) ? rawValue : [value];
      out[rawKey] = cookies.map(redactSetCookie).join(", ");
    } else if (key === "cookie") {
      out[rawKey] = redactCookieRequestHeader(value);
    } else if (SECRET_HEADER_NAMES.has(key) || extra.has(key)) {
      out[rawKey] = "<redacted>";
    } else if (HEADER_ALLOWLIST.has(key)) {
      out[rawKey] = value;
    }
    // Anything else isn't on the allowlist, so it's dropped rather than kept.
  }

  return out;
}

function maskSecretValues(value: unknown, extra: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => maskSecretValues(v, extra));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key, extra) ? "<redacted>" : maskSecretValues(v, extra);
    }
    return out;
  }
  return value;
}

/**
 * `email=a%40b.com&password=hunter2` - the body every HTML form and OAuth
 * token endpoint sends. A value may itself contain "=" (an unencoded base64
 * token does), so only the first one separates name from value.
 */
const FORM_BODY = /^[^\s=&]+=[^\s&]*(?:&[^\s=&]+=[^\s&]*)*$/;

/**
 * A field name is attacker- (or app-) supplied text, and `decodeURIComponent`
 * throws URIError on a stray `%` - `discount%=10` is enough. Redaction runs on
 * a response body outside any try/catch, so that threw away the whole run.
 * Nothing here may ever throw; an undecodable name is matched as-is instead.
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function redactFormBody(raw: string, extra: ReadonlySet<string>): string {
  return raw
    .split("&")
    .map((pair) => {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) return pair;
      const name = pair.slice(0, eqIdx);
      return isSecretKey(safeDecode(name), extra) ? `${name}=<redacted>` : pair;
    })
    .join("&");
}

/**
 * Masks the values of secret-looking fields, then truncates to 2KB. Reports
 * and `results.json` are meant to be safe to paste publicly (§7.7), and this
 * is the only thing standing between an app's login request and a pasted
 * report.
 *
 * Both body encodings Twin can send are handled. Only JSON used to be, which
 * meant `email=a&password=hunter2` - a plain form login, and the single most
 * likely body in any scenario's first step - was written to disk verbatim.
 */
export function redactBody(raw: string | undefined, extraSecretKeys: string[] = []): string | undefined {
  if (raw === undefined || raw.length === 0) return raw;
  const extra = new Set(extraSecretKeys.map(normalizeKey).filter((k) => k.length > 0));

  let text = raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    text = JSON.stringify(maskSecretValues(parsed, extra));
  } catch {
    // Not JSON. A form body is the other encoding Twin sends, and the one a
    // login almost always uses; anything else is truncated as-is.
    if (FORM_BODY.test(raw)) text = redactFormBody(raw, extra);
  }

  return truncate(text);
}

function truncate(text: string): string {
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}<truncated>` : text;
}

/** A JWT, or anything else shaped like one. Three base64url segments is not a value anyone needs to read. */
const JWT_SHAPED = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

/** How much of a mismatched value a failure message is allowed to quote. */
const MAX_MESSAGE_VALUE_CHARS = 160;

function maskCredentialStrings(value: unknown): unknown {
  if (typeof value === "string") return JWT_SHAPED.test(value) ? "<redacted>" : value;
  if (Array.isArray(value)) return value.map(maskCredentialStrings);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) out[key] = maskCredentialStrings(v);
    return out;
  }
  return value;
}

/**
 * Renders a value for an expectation-failure message, which is quoted in
 * `failedExpectations`, a finding's `summary`, report.json, results.json,
 * report.md, the fix prompt and the terminal.
 *
 * Those messages used to print the response value verbatim - body redaction
 * never reached them - so a scenario asserting on `$.token` put the real token
 * into a report that promises to be safe to paste publicly, and into CI logs.
 *
 * `fieldHint` is the JSONPath the value came from: when its last segment names
 * a secret, nothing of the value survives. Otherwise nested secret keys are
 * masked, anything JWT-shaped is masked wherever it sits, and the rest is
 * truncated - a mismatch is still diagnosable, which is the point of the
 * message.
 */
export function redactValueForMessage(value: unknown, fieldHint: string, extraSecretKeys: string[] = []): string {
  const extra = new Set(extraSecretKeys.map(normalizeKey).filter((k) => k.length > 0));
  const lastSegment = fieldHint.split(/[.[\]]/).filter((part) => part.length > 0).pop();

  if (lastSegment !== undefined && lastSegment !== "$" && isSecretKey(lastSegment, extra)) return "<redacted>";

  const masked = maskCredentialStrings(maskSecretValues(value, extra));
  const rendered = masked === undefined ? "undefined" : JSON.stringify(masked);
  if (rendered === undefined) return "undefined";
  return rendered.length > MAX_MESSAGE_VALUE_CHARS ? `${rendered.slice(0, MAX_MESSAGE_VALUE_CHARS)}<truncated>` : rendered;
}
