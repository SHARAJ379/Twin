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
  /** Per-request deadline for a scenario step, in ms. */
  requestTimeoutMs?: number;
  env?: Record<string, string>;
  allowRemote?: boolean;
  /** Hosts allowed individually, instead of switching the whole remote check off. A leading dot is a domain suffix. */
  allowRemoteHosts?: string[];
  /** Extra header names to redact from report evidence, beyond the built-in list. */
  redactHeaders?: string[];
}

export interface TwinConfigError {
  message: string;
  /** JSON-pointer-ish path into the config, e.g. "/bootTimeoutMs". */
  path: string;
}

export type TwinConfigValidationResult = { ok: true; config: TwinConfig } | { ok: false; errors: TwinConfigError[] };

const STRING_FIELDS = ["scenario", "stack", "start", "build", "healthPath", "portEnv"] as const;
const NUMBER_FIELDS = ["bootTimeoutMs", "requestTimeoutMs"] as const;
const STRING_ARRAY_FIELDS = ["redactHeaders", "allowRemoteHosts"] as const;
const ALLOWED_KEYS = new Set<string>([...STRING_FIELDS, ...NUMBER_FIELDS, ...STRING_ARRAY_FIELDS, "env", "allowRemote"]);

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
  for (const field of NUMBER_FIELDS) {
    if (!(field in obj)) continue;
    const value = obj[field];
    if (typeof value !== "number") {
      errors.push({ message: `"${field}" must be a number`, path: `/${field}` });
    } else if (!Number.isInteger(value) || value <= 0) {
      // A zero or negative deadline would make every request fail instantly,
      // which reads as "the app is broken" rather than "the config is".
      errors.push({ message: `"${field}" must be a positive whole number of milliseconds`, path: `/${field}` });
    }
  }
  for (const field of STRING_ARRAY_FIELDS) {
    if (field in obj && !(Array.isArray(obj[field]) && (obj[field] as unknown[]).every((v) => typeof v === "string"))) {
      errors.push({ message: `"${field}" must be an array of strings`, path: `/${field}` });
    }
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
