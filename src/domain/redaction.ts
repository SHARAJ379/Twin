// Reports must be safe to paste publicly (§7.7) - this is the one place that
// decides what evidence is allowed to survive into a StepResult/report.

const HEADER_ALLOWLIST = new Set(["content-type", "content-length", "location", "x-twin-instance"]);
const SECRET_HEADER_NAMES = new Set(["authorization"]);
const SECRET_BODY_KEYS = new Set(["password", "token", "secret", "key", "authorization"]);
const MAX_BODY_CHARS = 2048;

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
      out[rawKey] = redactSetCookie(value);
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

function maskSecretValues(value: unknown, secretKeys: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => maskSecretValues(v, secretKeys));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = secretKeys.has(key.toLowerCase()) ? "<redacted>" : maskSecretValues(v, secretKeys);
    }
    return out;
  }
  return value;
}

/** Masks JSON values whose key looks secret-ish, then truncates to 2KB. */
export function redactBody(raw: string | undefined, extraSecretKeys: string[] = []): string | undefined {
  if (raw === undefined || raw.length === 0) return raw;
  const secretKeys = new Set([...SECRET_BODY_KEYS, ...extraSecretKeys.map((k) => k.toLowerCase())]);

  let text = raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    text = JSON.stringify(maskSecretValues(parsed, secretKeys));
  } catch {
    // Not JSON - fall through and truncate the raw text as-is.
  }

  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}<truncated>` : text;
}
