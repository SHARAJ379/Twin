// {{var}} substitution for scenario steps (§6.8). {{unique}}/{{uuid}}/{{now}}
// are generated fresh per call via injected helpers so reruns don't collide
// with old data; {{var}} comes from a prior step's `save:`.

export class TemplateVariableError extends Error {
  constructor(public readonly variableName: string) {
    super(`undefined template variable: {{${variableName}}} (did a step that should have saved it run, and with the right name?)`);
    this.name = "TemplateVariableError";
  }
}

export interface TemplateHelpers {
  unique: () => string;
  uuid: () => string;
  now: () => string;
}

const TEMPLATE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

export function renderTemplate(input: string, variables: Readonly<Record<string, string>>, helpers: TemplateHelpers): string {
  return input.replace(TEMPLATE_PATTERN, (_match, nameRaw: string) => {
    const name = nameRaw.trim();
    if (name === "unique") return helpers.unique();
    if (name === "uuid") return helpers.uuid();
    if (name === "now") return helpers.now();

    const value = variables[name];
    if (value === undefined) throw new TemplateVariableError(name);
    return value;
  });
}

/** Recursively renders every string leaf of `value` (request bodies are nested objects). */
export function renderTemplateDeep(value: unknown, variables: Readonly<Record<string, string>>, helpers: TemplateHelpers): unknown {
  if (typeof value === "string") return renderTemplate(value, variables, helpers);
  if (Array.isArray(value)) return value.map((v) => renderTemplateDeep(v, variables, helpers));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = renderTemplateDeep(v, variables, helpers);
    }
    return out;
  }
  return value;
}
