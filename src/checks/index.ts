import type { Check } from "../domain/check.js";
import { dataConsistencyCheck } from "./dataConsistency.js";
import { sessionSurvivesSwitchCheck } from "./sessionSurvivesSwitch.js";

/** Every built-in check, keyed by id. New checks (file-consistency, restart-persistence, ...) register here. */
export const builtInChecks: ReadonlyMap<string, Check> = new Map(
  [sessionSurvivesSwitchCheck, dataConsistencyCheck].map((check) => [check.id, check])
);
