import { isAuthRejection } from "./authRejection.js";
import type { CheckInput, Finding } from "./check.js";
import type { CheckId } from "./scenario.js";

export interface ControlGateOptions {
  /**
   * True for a check whose own subject *is* the authentication (the session
   * check): a 401 is its finding, not something that stopped it short, so it
   * is never marked `blockedBy: "auth"`.
   */
  subjectIsAuthentication?: boolean;
}

/**
 * The trust mechanism every check is built on (§6.1, §6.4, invariant I7): a
 * split-run failure is only ever reported as "fail" if the *same* assertion
 * passed on a single instance in the control run. Otherwise the scenario or
 * app is broken on its own terms, and that's an "error", never a "fail" -
 * Twin must not blame multi-instance behavior for a bug that isn't one.
 *
 * Centralizing this in one function (rather than copying the gate into every
 * check) is deliberate: it is the one piece of logic that must never be
 * gotten wrong, so there is exactly one place it can be gotten wrong.
 */
export function evaluateControlGated(
  input: CheckInput,
  checkId: CheckId,
  title: string,
  describeFailure: (input: CheckInput) => string,
  options: ControlGateOptions = {}
): Finding {
  if (input.control === undefined) {
    return {
      checkId,
      status: "error",
      title,
      summary: "no control-run evidence for this step",
      evidence: [],
      suspects: [],
      reason: "the control run never produced a result for this step - Twin can't tell whether this is a multi-instance bug"
    };
  }

  if (!input.control.expectationsPassed) {
    return {
      checkId,
      status: "error",
      title,
      summary: "the scenario failed even on a single instance - this isn't a multi-instance bug",
      evidence: [
        { run: "control", stepId: input.control.stepId, note: input.control.failedExpectations.join("; ") }
      ],
      suspects: [],
      reason: "control run failed, so a split-run failure can't be attributed to multi-instance behavior (I7)"
    };
  }

  if (input.assertion.expectationsPassed) {
    return {
      checkId,
      status: "pass",
      title,
      summary: `${title}: passed`,
      evidence: [{ run: "split", stepId: input.assertion.stepId }],
      suspects: []
    };
  }

  return {
    checkId,
    status: "fail",
    title,
    summary: describeFailure(input),
    evidence: [
      { run: "control", stepId: input.control.stepId, note: "passed on a single instance" },
      { run: "split", stepId: input.assertion.stepId, note: input.assertion.failedExpectations.join("; ") }
    ],
    suspects: [],
    // Still a fail - the control gate just proved this request works on one
    // instance - but a 401/403 means it never reached this check's own
    // subject, so nothing downstream may blame that subject's code.
    ...(options.subjectIsAuthentication !== true && isAuthRejection(input.assertion)
      ? { blockedBy: "auth" as const }
      : {})
  };
}
