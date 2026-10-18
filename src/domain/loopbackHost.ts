/**
 * What every instance should listen on. Twin only ever reaches an instance
 * over 127.0.0.1 - its health poll, the scenario's requests, the proxy - so a
 * server listening on every network interface gains nothing from it, and
 * listening on a real interface is exactly what makes Windows Firewall stop
 * and ask whether to let the network in.
 */
export const LOOPBACK_HOST = "127.0.0.1";

/** The variables apps most often read their listen address from. */
export const LISTEN_HOST_VARS = ["HOST", "BIND_ADDRESS"] as const;

/**
 * HOST and BIND_ADDRESS set to 127.0.0.1, minus any the user already set - in
 * their shell, a .env file, twin.config.json "env" or --env - so an app that
 * reads one listens only on this machine, and a choice the user made stands.
 * On Windows environment names are case-insensitive, so `Host` counts as set.
 */
export function loopbackHostEnv(
  declared: Readonly<Record<string, string | undefined>>,
  caseInsensitive: boolean
): Record<string, string> {
  const normalize = (name: string): string => (caseInsensitive ? name.toUpperCase() : name);
  const set = new Set(
    Object.entries(declared)
      .filter(([, value]) => value !== undefined)
      .map(([name]) => normalize(name))
  );
  return Object.fromEntries(LISTEN_HOST_VARS.filter((name) => !set.has(normalize(name))).map((name) => [name, LOOPBACK_HOST]));
}
