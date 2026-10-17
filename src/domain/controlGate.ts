import { isAuthRejection } from "./authRejection.js";
import type { CheckInput, Finding } from "./check.js";
import { describeLostData } from "./responseDivergence.js";
import type { CheckId } from "./scenario.js";

export interface ControlGateOptions {
  /**
   * True for a check whose own subject *is* the authentication (the session
   * check): a 401 is its finding, not something that stopped it short, so it
   * is never marked `blockedBy: "auth"`.
   */
  subjectIsAuthentication?: boolean;
  /**
   * What the split run's routing must have done for a pass to mean anything:
   * the assertion served by a different instance than the write it reads
   * back, or by an instance restarted since that write.
   */
  requires?: "another-instance" | "a-restarted-instance";
}

/**
 * Why the split run never put this check's subject to the test, if it didn't.
 *
 * Steps without `via:` are round-robined, so a create on A, one unrelated GET
 * on B and the read-back on A is a perfectly ordinary routing - and a read
 * from the instance that did the write passes on an app that keeps everything
 * in memory. That was reported as safe to run on more than one instance when
 * nothing had crossed an instance at all. Which instance served each step is
 * recorded, so the claim can be checked rather than assumed.
 */
function notExercised(input: CheckInput, requires: NonNullable<ControlGateOptions["requires"]>): string | undefined {
  const served = input.assertion.instanceServed;
  // No response through the proxy (a refused connection, a timeout) says
  // nothing about routing; the gate below judges those on their own terms.
  if (served === undefined) return undefined;
  const stepId = input.assertion.stepId;

  if (requires === "a-restarted-instance") {
    const restarted = input.restartedBetween ?? [];
    if (restarted.includes(served)) return undefined;
    if (restarted.length === 0) {
      return `no instance was restarted between the write and step "${stepId}", so it only shows the data is there without a restart`;
    }
    return `step "${stepId}" was served by instance ${served}, which was not the one restarted - pin it with \`via: ${restarted[restarted.length - 1]}\``;
  }

  const writers = input.related.map((r) => r.instanceServed).filter((id): id is string => id !== undefined);
  if (writers.length === 0 || writers.some((id) => id !== served)) return undefined;
  return `step "${stepId}" was served by instance ${served}, the same instance as the write it reads back, so no instance switch happened - pin it with \`via:\` to the other instance`;
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

  const unexercised = options.requires === undefined ? undefined : notExercised(input, options.requires);
  if (unexercised !== undefined) {
    return {
      checkId,
      status: "error",
      title,
      summary: `not tested: ${unexercised}`,
      evidence: [{ run: "split", stepId: input.assertion.stepId, note: `served by instance ${input.assertion.instanceServed}` }],
      suspects: [],
      reason:
        "the split run's routing never exercised what this check is about, so neither a pass nor a fail says anything about running on more than one instance"
    };
  }

  // The scenario's own expect: is a floor, not the whole test: a response
  // that passes it can still have lost what the single instance returned.
  const lost = input.assertion.expectationsPassed ? describeLostData(input.control, input.assertion, input.history) : undefined;
  if (lost !== undefined) {
    return {
      checkId,
      status: "fail",
      title,
      // Not describeFailure: those describe a rejected request, and this one
      // was answered - with less than a single instance answered.
      summary: `step "${input.assertion.stepId}" passed its own expect:, but lost data across instances - ${lost}`,
      evidence: [
        { run: "control", stepId: input.control.stepId, note: "passed on a single instance" },
        {
          run: "split",
          stepId: input.assertion.stepId,
          note: `passed the scenario's own expect:, but differs from the single-instance response - ${lost}`
        }
      ],
      suspects: []
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
