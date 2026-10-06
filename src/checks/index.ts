import type { Check } from "../domain/check.js";
import { dataConsistencyCheck } from "./dataConsistency.js";
import { fileConsistencyCheck } from "./fileConsistency.js";
import { restartPersistenceCheck } from "./restartPersistence.js";
import { sessionSurvivesSwitchCheck } from "./sessionSurvivesSwitch.js";

/** Every built-in check, keyed by id - the four from TWIN_CONTEXT.md §5. */
export const builtInChecks: ReadonlyMap<string, Check> = new Map(
  [sessionSurvivesSwitchCheck, dataConsistencyCheck, fileConsistencyCheck, restartPersistenceCheck].map((check) => [
    check.id,
    check
  ])
);
