import { verdictHeadline, type Verdict } from "../domain/verdict.js";

/**
 * §7.8: fail takes precedence over error - exit 1 means "the app has a real
 * bug," exit 2 means "Twin couldn't tell." A run that verified nothing (no
 * checks, or every check skipped) is exit 2, not 0: silence isn't a pass.
 */
export function computeExitCode(verdict: Verdict): 0 | 1 | 2 {
  switch (verdictHeadline(verdict)) {
    case "unsafe":
      return 1;
    case "inconclusive":
      return 2;
    case "safe":
      return 0;
  }
}
