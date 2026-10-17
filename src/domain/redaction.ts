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
  "jwt",
  // Anti-forgery tokens: `_csrf` (csurf), `X-XSRF-TOKEN`, a form's hidden field.
  "csrf",
  "xsrf"
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
  "signature",
  // Django's `csrfmiddlewaretoken` has no boundary to split on.
  "csrf",
  "xsrf"
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
    } else if (key === "location") {
      // A redirect is where a magic link or an OAuth callback hands over its
      // credential: `/dashboard?session=...`, `/cb?code=...`, `#access_token=...`.
      out[rawKey] = redactUrl(value, extraRedact);
    } else if (HEADER_ALLOWLIST.has(key)) {
      out[rawKey] = value;
    }
    // Anything else isn't on the allowlist, so it's dropped rather than kept.
  }

  return out;
}

/**
 * Query and fragment parameters that carry a credential without a secret-
 * sounding name: an OAuth authorization code, and the `state` bound to it.
 */
const URL_SECRET_PARAMS = new Set(["code", "state", "sid", "ticket", "nonce"]);

function redactParams(params: string, extra: ReadonlySet<string>): string {
  return params
    .split("&")
    .map((pair) => {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) return pair;
      const name = pair.slice(0, eqIdx);
      const decodedName = safeDecode(name);
      const value = safeDecode(pair.slice(eqIdx + 1));
      const secret =
        isSecretKey(decodedName, extra) || URL_SECRET_PARAMS.has(normalizeKey(decodedName)) || looksOpaquelySecret(value);
      return secret ? `${name}=<redacted>` : pair;
    })
    .join("&");
}

/**
 * Path words after which the next segment is the credential itself:
 * `/reset/<token>`, `/verify/<code>`, `/magic/<link-id>`, `/invite/<code>`.
 */
const CREDENTIAL_PATH_WORDS = new Set([
  "token",
  "tokens",
  "reset",
  "reset-password",
  "password-reset",
  "verify",
  "verification",
  "confirm",
  "confirmation",
  "activate",
  "magic",
  "magic-link",
  "invite",
  "invitation",
  "otp",
  "unsubscribe",
  "session",
  "sessions"
]);

/**
 * Query strings were already masked, but a token can be the path itself:
 * `/reset/<token>` and `/verify/<token>` were saved into results.json
 * verbatim. A segment is masked when it's shaped like a credential, or when
 * the segment before it says that's what comes next. Record ids stay
 * readable - UUIDs and short hex ids aren't token-shaped, and they rarely
 * follow one of those words.
 */
function redactPathSegments(base: string): string {
  const schemeEnd = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(base)?.[0] ?? "";
  const segments = base.slice(schemeEnd.length).split("/");
  return (
    schemeEnd +
    segments
      .map((segment, i) => {
        if (segment.length === 0) return segment;
        const previous = (segments[i - 1] ?? "").toLowerCase();
        return CREDENTIAL_PATH_WORDS.has(previous) || looksOpaquelySecret(safeDecode(segment)) ? "<redacted>" : segment;
      })
      .join("/")
  );
}

/**
 * A URL with any credential in it masked: secret-named or token-shaped query
 * and fragment values, and a password in the userinfo. The path is kept - it
 * is what the evidence is about - and so are ordinary parameters like
 * `?page=2`.
 *
 * Request paths and `Location` headers both used to be stored raw, so
 * `/verify?token={{token}}` saved the real token into results.json, and a
 * magic-link or OAuth redirect saved the session it handed over.
 */
export function redactUrl(url: string, extraSecretKeys: readonly string[] = []): string {
  const extra = new Set(extraSecretKeys.map(normalizeKey).filter((k) => k.length > 0));
  const hashIdx = url.indexOf("#");
  const beforeHash = hashIdx === -1 ? url : url.slice(0, hashIdx);
  const fragment = hashIdx === -1 ? undefined : url.slice(hashIdx + 1);
  const queryIdx = beforeHash.indexOf("?");
  // scheme://user:password@host - keep the user, never the password.
  const base = (queryIdx === -1 ? beforeHash : beforeHash.slice(0, queryIdx)).replace(
    /^([a-z][a-z0-9+.-]*:\/\/[^/@:]*):[^/@]*@/i,
    "$1:<redacted>@"
  );
  const query = queryIdx === -1 ? undefined : beforeHash.slice(queryIdx + 1);

  return (
    redactPathSegments(base) +
    (query === undefined ? "" : `?${redactParams(query, extra)}`) +
    (fragment === undefined ? "" : `#${fragment.includes("=") ? redactParams(fragment, extra) : fragment}`)
  );
}

/**
 * `<input type="hidden" name="_csrf" value="...">`, `<meta name="csrf-token"
 * content="...">`: a tag whose name says it holds a secret has its value
 * masked. Only those attributes, on those two tags - the rest of the page is
 * evidence a human needs to read.
 */
function redactHtml(raw: string, extra: ReadonlySet<string>): string {
  return raw.replace(/<(?:input|meta)\b[^>]*>/gi, (tag) => {
    const name = /\b(?:name|id|property)\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (name === undefined || !isSecretKey(name, extra)) return tag;
    return tag.replace(/\b(value|content)(\s*=\s*)(["'])[^"']*(["'])/gi, "$1$2$3<redacted>$4");
  });
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
    // HTML is what a server-rendered app answers with, and it carries its
    // CSRF token in a hidden field or a meta tag.
    else if (/<[a-z!]/i.test(raw)) text = redactHtml(raw, extra);
  }

  return truncate(text);
}

function truncate(text: string): string {
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}<truncated>` : text;
}

/** A JWT, or anything else shaped like one. Three base64url segments is not a value anyone needs to read. */
const JWT_SHAPED = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

/**
 * Prefixes that announce a credential outright, whatever field it arrives in.
 * A value like `sk_live_...` is a live payment key no matter that the path
 * says `$.data.value`.
 */
const CREDENTIAL_PREFIXES = [
  "sk_live_",
  "sk_test_",
  "rk_live_",
  "pk_live_",
  "whsec_",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "github_pat_",
  "glpat-",
  "xoxb-",
  "xoxp-",
  "xoxa-",
  "xoxs-",
  "xapp-",
  "AKIA",
  "ASIA",
  "AIza",
  "ya29.",
  "SG.",
  "shpat_",
  "npm_",
  "dop_v1_",
  "-----BEGIN"
];

/** 8-4-4-4-12. Overwhelmingly a record id, and masking every one would gut the messages. */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One long unbroken run of credential-ish characters, mixing letters and
 * digits - a session id, an API key, a signed blob. Nothing a human reads for
 * meaning looks like this, while a great many secrets do, and a failure
 * message that quotes one publishes it.
 *
 * No `.` in the set: it put every file name with an extension in scope
 * (`uploads/twin-test-4f2a1b2c.txt`), and the dotted credentials - JWTs,
 * `ya29.`, `SG.` - are caught by their own shapes above.
 */
const OPAQUE_TOKEN = /^[A-Za-z0-9_\-+/=]{24,}$/;

/**
 * Hex shorter than a 128-bit key. A MongoDB ObjectId is 24 hex characters and
 * a record id, not a credential; hex session ids and keys are 32 and up.
 */
const SHORT_HEX_ID = /^[0-9a-f]{1,31}$/i;

function looksOpaquelySecret(value: string): boolean {
  if (CREDENTIAL_PREFIXES.some((prefix) => value.startsWith(prefix))) return true;
  if (JWT_SHAPED.test(value)) return true;
  if (CANONICAL_UUID.test(value) || SHORT_HEX_ID.test(value)) return false;
  if (!OPAQUE_TOKEN.test(value)) return false;
  // Letters and digits together: "aaaaaaaa..." and "1234567890..." are a test
  // fixture or a serial, not a key.
  return /[A-Za-z]/.test(value) && /\d/.test(value);
}

/** How much of a mismatched value a failure message is allowed to quote. */
const MAX_MESSAGE_VALUE_CHARS = 160;

function maskCredentialStrings(value: unknown): unknown {
  if (typeof value === "string") return looksOpaquelySecret(value) ? "<redacted>" : value;
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
 * `fieldHint` is the JSONPath the value came from, and *any* segment of it
 * naming a secret masks the value entirely. Only the last segment used to be
 * checked, which missed `$.tokens[0]` - where the last segment is the index
 * `0` - and every other path whose secret-naming part isn't at the end.
 *
 * Otherwise nested secret keys are masked, so are strings that announce
 * themselves as credentials wherever they sit, and the rest is truncated - a
 * mismatch is still diagnosable, which is the point of the message.
 */
export function redactValueForMessage(value: unknown, fieldHint: string, extraSecretKeys: string[] = []): string {
  const extra = new Set(extraSecretKeys.map(normalizeKey).filter((k) => k.length > 0));
  const segments = fieldHint.split(/[.[\]]/).filter((part) => part.length > 0 && part !== "$");

  const named = segments.filter((segment) => !/^\d+$/.test(segment));
  const last = named[named.length - 1];

  if (segments.some((segment) => isSecretKey(segment, extra))) return "<redacted>";
  if (last !== undefined && pluralNamesSecret(last, extra)) return "<redacted>";

  const masked = maskCredentialStrings(maskSecretValues(value, extra));
  // A whole scalar that got masked reads better unquoted: `got <redacted>`,
  // not `got "<redacted>"`. Masks nested inside an object stay as JSON values.
  if (masked === "<redacted>") return "<redacted>";
  const rendered = masked === undefined ? "undefined" : JSON.stringify(masked);
  if (rendered === undefined) return "undefined";
  return rendered.length > MAX_MESSAGE_VALUE_CHARS ? `${rendered.slice(0, MAX_MESSAGE_VALUE_CHARS)}<truncated>` : rendered;
}

/**
 * A collection of secrets is usually named in the plural (`$.tokens[0]`), and
 * the body-field rules deliberately don't treat `keys` as `key` -
 * `keys_pressed` has to stay readable there.
 *
 * Only for the last named segment, though - the one that says what the value
 * *is*. Applied to every segment it masked `$.keys[0].owner`, which is "Alice":
 * plurals like `keys` name ordinary records far too often for everything
 * under them to be a secret. A singular secret word anywhere still masks.
 */
function pluralNamesSecret(segment: string, extra: ReadonlySet<string>): boolean {
  const singular = segment.replace(/s$/i, "");
  return singular.length > 0 && singular !== segment && isSecretKey(singular, extra);
}
