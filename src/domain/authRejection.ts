import type { StepResult } from "./stepResult.js";

/**
 * 401/403 mean the request was refused at the door: no handler ran, so nothing
 * was read from the store, from the disk, or from anywhere else a check is
 * named after.
 *
 * A read-back that comes back 401 has still found a real multi-instance
 * divergence - the control gate (I7) proved the same request passed on a
 * single instance - so it stays a "fail". But the thing that diverged is the
 * session layer, not the layer the check is named after, and saying "the
 * record could not be read back" would be a claim Twin never tested. Both the
 * summary and the tracer's suspects follow this instead of the check id.
 */
const AUTH_REJECTION_STATUSES = new Set([401, 403]);

export function isAuthRejection(result: StepResult): boolean {
  const status = result.response?.status;
  return status !== undefined && AUTH_REJECTION_STATUSES.has(status);
}

/** Where the refusal happened - the second half of the summary has to match the check's own shape. */
export type AuthRefusalSite =
  /** The request went to a different instance than the one that logged in. */
  | "other-instance"
  /** The request went back to the same instance, after that instance restarted. */
  | "after-restart";

const REFUSED: Record<AuthRefusalSite, string> = {
  "other-instance": "was refused on another",
  "after-restart": "was refused by that same instance after it restarted"
};

/**
 * Shared wording for the checks whose subject sits behind authentication.
 * `subject` is what the request never got to ("any record", "the file"), and
 * `site` keeps the second sentence true for the check at hand: three of these
 * checks read via a second instance, but restart-persistence reads back via
 * the same one, so "refused on another" would be a claim about an instance
 * that was never in the request.
 */
export function describeAuthRejectedFailure(
  request: string,
  subject: string,
  status: number | string,
  site: AuthRefusalSite
): string {
  return (
    `${request} never reached ${subject}: it was rejected with status ${status}. ` +
    `An authenticated request that worked on a single instance ${REFUSED[site]}, ` +
    `so the session is what diverged here`
  );
}
