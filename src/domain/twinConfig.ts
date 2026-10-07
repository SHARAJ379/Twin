/** Project-level defaults for `twin run` (§16, E_CONFIG_INVALID) - every field is overridable by its matching CLI flag. */
export interface TwinConfig {
  scenario?: string;
  /** Forces the language stack ("node" | "python" | "go" | "ruby" | "php") instead of detecting it. */
  stack?: string;
  start?: string;
  build?: string;
  healthPath?: string;
  portEnv?: string;
  bootTimeoutMs?: number;
  env?: Record<string, string>;
  allowRemote?: boolean;
}

export interface TwinConfigError {
  message: string;
  /** JSON-pointer-ish path into the config, e.g. "/bootTimeoutMs". */
  path: string;
}

export type TwinConfigValidationResult = { ok: true; config: TwinConfig } | { ok: false; errors: TwinConfigError[] };

const STRING_FIELDS = ["scenario", "stack", "start", "build", "healthPath", "portEnv"] as const;
const ALLOWED_KEYS = new Set<string>([...STRING_FIELDS, "bootTimeoutMs", "env", "allowRemote"]);

/** No YAML/ajv here on purpose (cf. domain/jsonPath.ts) - a flat handful of fields doesn't earn the dependency. */
export function validateTwinConfig(data: unknown): TwinConfigValidationResult {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, errors: [{ message: "must be a JSON object", path: "" }] };
  }
  const obj = data as Record<string, unknown>;
  const errors: TwinConfigError[] = [];

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) errors.push({ message: `unknown property "${key}"`, path: `/${key}` });
  }
  for (const field of STRING_FIELDS) {
    if (field in obj && typeof obj[field] !== "string") {
      errors.push({ message: `"${field}" must be a string`, path: `/${field}` });
    }
  }
  if ("bootTimeoutMs" in obj && typeof obj.bootTimeoutMs !== "number") {
    errors.push({ message: '"bootTimeoutMs" must be a number', path: "/bootTimeoutMs" });
  }
  if ("allowRemote" in obj && typeof obj.allowRemote !== "boolean") {
    errors.push({ message: '"allowRemote" must be a boolean', path: "/allowRemote" });
  }
  if ("env" in obj) {
    const env = obj.env;
    const isStringMap =
      typeof env === "object" && env !== null && !Array.isArray(env) && Object.values(env).every((v) => typeof v === "string");
    if (!isStringMap) errors.push({ message: '"env" must be an object of string values', path: "/env" });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: obj as TwinConfig };
}
