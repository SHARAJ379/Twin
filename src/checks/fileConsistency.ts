import type { Check, CheckInput } from "../domain/check.js";
import { evaluateControlGated } from "../domain/controlGate.js";

const ID = "file-consistency";
const TITLE = "File consistency";

function describeFailure(input: CheckInput): string {
  const status = input.assertion.response?.status ?? "no response";
  return `a file uploaded via one instance could not be fetched back via another instance (status ${status})`;
}

/**
 * Check 3 (TWIN_CONTEXT.md §5): upload a file via A, fetch it via B - must
 * exist. Pass/fail follows the same control gate as every other check; the
 * workspace diff is what lets the tracer point at the exact write site with
 * high confidence (§6.5: a file only on A's disk is direct proof).
 */
export const fileConsistencyCheck: Check = {
  id: ID,
  title: TITLE,
  explanation:
    "If your app saves uploads to local disk (e.g. multer's default diskStorage), each instance has its own private disk - a file uploaded to one instance simply isn't there on another.",
  evaluate(input: CheckInput) {
    return evaluateControlGated(input, ID, TITLE, describeFailure);
  }
};
