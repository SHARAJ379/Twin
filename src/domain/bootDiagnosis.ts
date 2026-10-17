/**
 * Ports an app's own startup output says it is listening on: "listening on
 * port 3000", "Server running at http://localhost:8080/", "Uvicorn running on
 * http://127.0.0.1:8000", "Listening on 0.0.0.0:4567".
 *
 * Used when an instance stays alive but never answers on the port Twin
 * assigned, which almost always means the app ignores the port variable and
 * binds one of its own. Only lines that announce a server are read, so a
 * database URL or a version number in the log isn't mistaken for one.
 */
export function portsAnnouncedInLog(lines: readonly string[]): number[] {
  const found = new Set<number>();
  const announcement = /\b(listen(ing|s)?|running|started|serving|server|ready|bound|available)\b/i;
  const port = /(?:\bport\s*[:=]?\s*|(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|::):|https?:\/\/[\w.-]+:)(\d{2,5})\b/gi;
  for (const line of lines) {
    if (!announcement.test(line)) continue;
    for (const match of line.matchAll(port)) {
      const value = Number(match[1]);
      if (value > 0 && value < 65536) found.add(value);
    }
  }
  return [...found];
}
