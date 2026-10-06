import type { Check, CheckInput } from "../domain/check.js";
import { evaluateControlGated } from "../domain/controlGate.js";

const ID = "session-survives-switch";
const TITLE = "Session survives instance switch";

function describeFailure(input: CheckInput): string {
  const status = input.assertion.response?.status ?? "no response";
  return `logged in via one instance, but the follow-up authenticated request via another instance was rejected (status ${status})`;
}

/**
 * Check 1 (TWIN_CONTEXT.md §5): login on A, authenticated request on B was
 * rejected/anonymous. The scenario does the actual login+request; this
 * check just interprets whether the tagged assertion step passed.
 */
export const sessionSurvivesSwitchCheck: Check = {
  id: ID,
  title: TITLE,
  explanation:
    "If your app stores login sessions only in memory (or in a cookie signed with a per-process secret), a user logged in via one instance gets logged out as soon as a later request lands on a different instance.",
  evaluate(input: CheckInput) {
    return evaluateControlGated(input, ID, TITLE, describeFailure);
  }
};
