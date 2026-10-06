import type { ErrorObject } from "ajv";
import { createRequire } from "node:module";
import { parseDocument, type Document } from "yaml";

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

function formatAjvError(err: ErrorObject): string {
  if (err.keyword === "additionalProperties") {
    const extra = (err.params as { additionalProperty?: string }).additionalProperty;
    return `unknown property "${extra ?? "?"}"`;
  }
  if (err.keyword === "oneOf") {
    return `does not match any known step shape (request/restart/wait) - check "kind" and required fields`;
  }
  return `${err.instancePath.length > 0 ? err.instancePath : "(root)"} ${err.message ?? "is invalid"}`;
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

  const data: unknown = doc.toJS({ maxAliasCount: -1 });

  if (!validateSchema(data)) {
    const errors = (validateSchema.errors ?? []).map((err) => ({
      message: formatAjvError(err),
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
