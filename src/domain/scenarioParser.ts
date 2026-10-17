import type { ErrorObject } from "ajv";
import { createRequire } from "node:module";
import { isCollection, parseDocument, visit, type Document } from "yaml";

import type { Scenario } from "./scenario.js";
import { scenarioSchema } from "./scenarioSchema.js";

// ajv's CJS default export doesn't resolve cleanly as a default import under
// NodeNext ESM (TS sees the module namespace, not the constructor) - go
// through require() directly rather than fight the interop.
const require = createRequire(import.meta.url);
const Ajv: typeof import("ajv").default = require("ajv");

export interface ScenarioParseError {
  message: string;
  /** JSON-pointer-ish path into the scenario, e.g. "/steps/2/via". */
  path: string;
  line?: number | undefined;
  column?: number | undefined;
}

export type ScenarioParseResult = { ok: true; scenario: Scenario } | { ok: false; errors: ScenarioParseError[] };

/**
 * Weighted alias budget for YAML expansion (the `yaml` library's own default
 * is 100; this is deliberately roomier, since a scenario legitimately merges
 * one shared block into every step).
 */
const MAX_YAML_ALIAS_BUDGET = 1000;

const ajv = new Ajv({ allErrors: true, strict: true });
const validateSchema = ajv.compile(scenarioSchema);

function offsetToLineCol(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: offset - lastNewline };
}

function pointerToPath(instancePath: string): (string | number)[] {
  if (instancePath === "") return [];
  return instancePath
    .split("/")
    .slice(1)
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg));
}

function locate(doc: Document, instancePath: string, source: string): { line?: number; column?: number } {
  try {
    const node: unknown = doc.getIn(pointerToPath(instancePath), true);
    const range = (node as { range?: [number, number, number] } | null)?.range;
    return range === undefined ? {} : offsetToLineCol(source, range[0]);
  } catch {
    return {};
  }
}

const STEP_PATH = /^\/steps\/(\d+)$/;
const STEP_KINDS = ["request", "restart", "wait"] as const;

function formatAjvError(err: ErrorObject, data: unknown): string {
  if (err.keyword === "additionalProperties") {
    const extra = (err.params as { additionalProperty?: string }).additionalProperty;
    return `unknown property "${extra ?? "?"}"`;
  }
  if (err.keyword === "oneOf" && STEP_PATH.test(err.instancePath)) {
    return `does not match any known step shape (request/restart/wait) - check "kind" and required fields`;
  }
  if (err.keyword === "oneOf" && err.instancePath.endsWith("/expect/status")) {
    const value = valueAt(data, err.instancePath);
    return typeof value === "string"
      ? `${err.instancePath} must be a number, not a string - write ${value}, not "${value}"`
      : `${err.instancePath} must be a status code or a list of them, e.g. 200 or [200, 201]`;
  }
  return `${err.instancePath.length > 0 ? err.instancePath : "(root)"} ${err.message ?? "is invalid"}`;
}

function valueAt(data: unknown, instancePath: string): unknown {
  return pointerToPath(instancePath).reduce<unknown>(
    (node, key) => (node !== null && typeof node === "object" ? (node as Record<string | number, unknown>)[key] : undefined),
    data
  );
}

/**
 * The step union is a oneOf, and Ajv reports every branch's complaints: a
 * request step with one bad field also "must have required property
 * 'instance'" (restart) and has an "unknown property 'request'" (wait). Those
 * are noise when the step says which kind it is, so only its own branch's
 * errors are kept - and the oneOf summary only when there is nothing more
 * specific to say. A step with no usable `kind` keeps one clear error.
 */
function relevantErrors(errors: readonly ErrorObject[], data: unknown): ErrorObject[] {
  const kindOf = (stepIndex: string): string | undefined => {
    const kind = valueAt(data, `/steps/${stepIndex}/kind`);
    return typeof kind === "string" && (STEP_KINDS as readonly string[]).includes(kind) ? kind : undefined;
  };

  const kept = errors.filter((err) => {
    const step = /^\/steps\/(\d+)(\/|$)/.exec(err.instancePath)?.[1];
    if (step === undefined) return true;
    const kind = kindOf(step);
    const branch = /#\/\$defs\/(request|restart|wait)Step\//.exec(err.schemaPath)?.[1];
    if (kind === undefined) return err.keyword === "oneOf" && STEP_PATH.test(err.instancePath);
    if (branch !== undefined) return branch === kind;
    // The step-level oneOf summary: redundant once the branch says what's wrong.
    return !(err.keyword === "oneOf" && STEP_PATH.test(err.instancePath));
  });

  // A oneOf nested inside the step (status: integer | integer[]) also reports
  // each alternative; its own summary, reworded above, says it better.
  const nestedOneOf = new Set(kept.filter((err) => err.keyword === "oneOf").map((err) => err.instancePath));
  return kept.filter((err) => err.keyword === "oneOf" || !nestedOneOf.has(err.instancePath));
}

/**
 * `path: {{id}}` unquoted is a YAML flow mapping whose key is another
 * mapping - easy to write, since templates use `{{ }}`. The yaml library
 * prints a raw "Keys with collection values will be stringified" warning for
 * it, then the schema reports errors about something the user never wrote.
 * Caught before either, with the fix spelled out.
 */
function unquotedTemplates(doc: Document, source: string): ScenarioParseError[] {
  const errors: ScenarioParseError[] = [];
  visit(doc, {
    Pair(_, pair) {
      if (!isCollection(pair.key)) return;
      const offset = pair.key.range?.[0] ?? 0;
      const text = source.slice(Math.max(0, offset - 1), source.indexOf("}}", offset) + 2);
      const template = text.startsWith("{{") ? text : `{${text}`;
      errors.push({
        message: `a {{ }} template has to be quoted - write "${template}", not ${template} (unquoted, YAML reads it as a nested mapping)`,
        path: "",
        ...offsetToLineCol(source, offset)
      });
      return visit.SKIP;
    }
  });
  return errors;
}

/** Parses + validates scenario.yaml: YAML syntax, then JSON Schema shape, then semantic rules (§7.1). */
export function parseScenarioYaml(yamlText: string, options: { knownInstances?: string[] } = {}): ScenarioParseResult {
  const knownInstances = options.knownInstances ?? ["A", "B"];
  const doc = parseDocument(yamlText);

  if (doc.errors.length > 0) {
    return {
      ok: false,
      errors: doc.errors.map((err) => ({
        message: err.message,
        path: "",
        line: err.linePos?.[0]?.line,
        column: err.linePos?.[0]?.col
      }))
    };
  }

  // Bounded, not disabled. Anchor expansion is multiplicative, so a handful
  // of nested aliases can expand to gigabytes ("billion laughs") - and an
  // unbounded limit turns a mistyped anchor into an out-of-memory crash
  // instead of a parse error. The budget is generous enough for the reason
  // anchors get used here (a shared block merged into every step) and still
  // caps expansion. It is not a security boundary: a scenario sits next to a
  // `start` command Twin runs unsandboxed, so whoever can write one can
  // already run code (see SECURITY.md).
  const templateErrors = unquotedTemplates(doc, yamlText);
  if (templateErrors.length > 0) return { ok: false, errors: templateErrors };

  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: MAX_YAML_ALIAS_BUDGET });
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          message: `${err instanceof Error ? err.message : String(err)} - alias expansion is capped at ${MAX_YAML_ALIAS_BUDGET}`,
          path: ""
        }
      ]
    };
  }

  if (!validateSchema(data)) {
    const errors = relevantErrors(validateSchema.errors ?? [], data).map((err) => ({
      message: formatAjvError(err, data),
      path: err.instancePath,
      ...locate(doc, err.instancePath, yamlText)
    }));
    return { ok: false, errors };
  }

  const scenario = data as Scenario;
  const semanticErrors = checkSemantics(scenario, knownInstances, doc, yamlText);
  if (semanticErrors.length > 0) return { ok: false, errors: semanticErrors };

  return { ok: true, scenario };
}

function checkSemantics(scenario: Scenario, knownInstances: string[], doc: Document, source: string): ScenarioParseError[] {
  const errors: ScenarioParseError[] = [];
  const idsSoFar = new Set<string>();
  const validVia = new Set([...knownInstances, "any"]);
  // "default" is the jar a step gets when it doesn't ask for one, so it never
  // needs declaring.
  const declaredClients = new Set(["default", ...(scenario.clients ?? [])]);

  for (let index = 0; index < scenario.steps.length; index++) {
    const step = scenario.steps[index]!;
    const stepPath = `/steps/${index}`;

    if (idsSoFar.has(step.id)) {
      errors.push({ message: `duplicate step id "${step.id}"`, path: `${stepPath}/id`, ...locate(doc, `${stepPath}/id`, source) });
    }

    if (step.kind === "request") {
      if (step.via !== undefined && !validVia.has(step.via)) {
        errors.push({
          message: `"via: ${step.via}" is not a known instance (expected one of ${[...validVia].join(", ")})`,
          path: `${stepPath}/via`,
          ...locate(doc, `${stepPath}/via`, source)
        });
      }
      if (step.as !== undefined && !declaredClients.has(step.as)) {
        errors.push({
          message:
            scenario.clients === undefined
              ? `"as: ${step.as}" is not a declared client - add a top-level \`clients: ["${step.as}"]\`. An undeclared client is almost always a typo, and a typo here sends the request with no cookies at all rather than failing`
              : `"as: ${step.as}" is not one of the scenario's declared clients (${[...declaredClients].join(", ")})`,
          path: `${stepPath}/as`,
          ...locate(doc, `${stepPath}/as`, source)
        });
      }
      for (const dep of step.after ?? []) {
        if (!idsSoFar.has(dep)) {
          errors.push({
            message: `"after: ${dep}" must refer to an earlier step's id, but no earlier step has that id`,
            path: `${stepPath}/after`,
            ...locate(doc, `${stepPath}/after`, source)
          });
        }
      }
    }

    if (step.kind === "restart" && !knownInstances.includes(step.instance)) {
      errors.push({
        message: `"instance: ${step.instance}" is not a known instance (expected one of ${knownInstances.join(", ")})`,
        path: `${stepPath}/instance`,
        ...locate(doc, `${stepPath}/instance`, source)
      });
    }

    idsSoFar.add(step.id);
  }

  return errors;
}
