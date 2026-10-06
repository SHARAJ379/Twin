import { extractJsonPath } from "./jsonPath.js";

export class SaveExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveExpressionError";
  }
}

/** Evaluates a scenario `save:` expression ("$.id" or "header:Set-Cookie") against a response. */
export function evaluateSaveExpression(
  spec: string,
  body: unknown,
  headers: Readonly<Record<string, string | string[] | undefined>>
): string {
  if (spec.startsWith("header:")) {
    const name = spec.slice("header:".length).trim().toLowerCase();
    const value = headers[name];
    if (value === undefined) throw new SaveExpressionError(`save: header "${name}" was not present in the response`);
    return Array.isArray(value) ? value[0] ?? "" : value;
  }
  if (spec.startsWith("$")) {
    const result = extractJsonPath(body, spec);
    return typeof result === "string" ? result : JSON.stringify(result);
  }
  throw new SaveExpressionError(`unsupported save expression: "${spec}" (expected "$.path" or "header:Name")`);
}
