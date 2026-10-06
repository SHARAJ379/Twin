import type { Verdict } from "../domain/verdict.js";

/** §7.8: fail takes precedence over error - exit 1 means "the app has a real bug," exit 2 means "Twin couldn't tell." */
export function computeExitCode(verdict: Verdict): 0 | 1 | 2 {
  if (verdict.failed > 0) return 1;
  if (verdict.errored > 0) return 2;
  return 0;
}
