interface StoredCookie {
  name: string;
  value: string;
  path: string;
  expiresAt?: number | undefined;
}

function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === "/") return true;
  if (requestPath === cookiePath) return true;
  return requestPath.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);
}

function parseSetCookie(header: string): StoredCookie | undefined {
  const parts = header.split(";").map((p) => p.trim());
  const first = parts[0];
  if (first === undefined || first.length === 0) return undefined;
  const eqIdx = first.indexOf("=");
  if (eqIdx === -1) return undefined;

  const name = first.slice(0, eqIdx);
  const value = first.slice(eqIdx + 1);
  let path = "/";
  let expiresAt: number | undefined;

  for (const attr of parts.slice(1)) {
    const eq = attr.indexOf("=");
    const key = (eq === -1 ? attr : attr.slice(0, eq)).trim().toLowerCase();
    const val = eq === -1 ? undefined : attr.slice(eq + 1).trim();

    if (key === "path" && val !== undefined) path = val;
    if (key === "max-age" && val !== undefined) {
      const seconds = Number(val);
      if (Number.isFinite(seconds)) expiresAt = Date.now() + seconds * 1000;
    }
    if (key === "expires" && val !== undefined && expiresAt === undefined) {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) expiresAt = t;
    }
    // HttpOnly/Secure/SameSite only constrain browser JS/transport choice - not
    // relevant here. Secure cookies are treated as sendable on localhost (§6.7).
  }

  return { name, value, path, expiresAt };
}

/**
 * One cookie store per named client ("as:" in a scenario step) - §6.7.
 * HttpOnly is ignored on purpose: it only restricts browser-side JS, not
 * whether the cookie gets sent, which is all a scenario runner cares about.
 */
export class CookieJar {
  private readonly byClient = new Map<string, Map<string, StoredCookie>>();

  ingest(client: string, setCookieHeaders: readonly string[]): void {
    if (setCookieHeaders.length === 0) return;
    const jar = this.jarFor(client);
    const now = Date.now();
    for (const header of setCookieHeaders) {
      const cookie = parseSetCookie(header);
      if (cookie === undefined) continue;
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
        jar.delete(cookie.name);
        continue;
      }
      jar.set(cookie.name, cookie);
    }
  }

  /** The Cookie header value to send for `requestPath`, or undefined if nothing applies. */
  headerFor(client: string, requestPath: string): string | undefined {
    const jar = this.byClient.get(client);
    if (jar === undefined) return undefined;
    const now = Date.now();
    const applicable = [...jar.values()].filter(
      (c) => (c.expiresAt === undefined || c.expiresAt > now) && pathMatches(c.path, requestPath)
    );
    return applicable.length === 0 ? undefined : applicable.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  private jarFor(client: string): Map<string, StoredCookie> {
    let jar = this.byClient.get(client);
    if (jar === undefined) {
      jar = new Map();
      this.byClient.set(client, jar);
    }
    return jar;
  }
}
