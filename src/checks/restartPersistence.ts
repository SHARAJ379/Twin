import type { Check, CheckInput } from "../domain/check.js";
import { evaluateControlGated } from "../domain/controlGate.js";

const ID = "restart-persistence";
const TITLE = "Restart persistence";

function describeFailure(input: CheckInput): string {
  const status = input.assertion.response?.status ?? "no response";
  return `data created before an instance restart could not be read back afterwards (status ${status})`;
}

/**
 * Check 4 (TWIN_CONTEXT.md §5): create a record, restart that instance, read
 * it back - must exist (honours `disk: fresh|keep`, §6.6). The control
 * scenario drops restart steps entirely (§3), so its version of the tagged
 * assertion is just a same-instance read with no restart in between - which
 * passes trivially on a working app, making this gate meaningful rather than
 * circular.
 */
export const restartPersistenceCheck: Check = {
  id: ID,
  title: TITLE,
  explanation:
    "If your app keeps data only in memory, restarting an instance (a redeploy, a crash, an autoscaler cycling it) wipes it - exactly like running a second instance does, just delayed.",
  evaluate(input: CheckInput) {
    return evaluateControlGated(input, ID, TITLE, describeFailure);
  }
};
