import type { Check, CheckInput } from "../domain/check.js";
import { evaluateControlGated } from "../domain/controlGate.js";

const ID = "data-consistency";
const TITLE = "Data consistency";

function describeFailure(input: CheckInput): string {
  const status = input.assertion.response?.status ?? "no response";
  return `a record created via one instance could not be read back via another instance (status ${status})`;
}

/**
 * Check 2 (TWIN_CONTEXT.md §5): create a record via A, read it via B - must
 * exist. Catches module-level in-memory stores and local SQLite files,
 * which diverge per instance by construction (§7.5 workspace isolation).
 */
export const dataConsistencyCheck: Check = {
  id: ID,
  title: TITLE,
  explanation:
    "If your app keeps application data in a module-level variable or a local SQLite file, each instance has its own copy - a record created on one instance simply doesn't exist on another.",
  evaluate(input: CheckInput) {
    return evaluateControlGated(input, ID, TITLE, describeFailure);
  }
};
