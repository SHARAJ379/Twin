import type { Scenario } from "../domain/scenario.js";
import type { StepResult } from "../domain/stepResult.js";
import type { InstanceDriver, InstanceHandle } from "./instanceDriver.js";

export interface RunContext {
  /** The proxy's base URL - every request step goes through this, never direct to an instance. */
  proxyUrl: string;
  instanceDriver: InstanceDriver;
  /**
   * Live and mutable: the Proxy reads instance state from this same array
   * reference, so a restart step must update it in place, not replace it.
   */
  instances: InstanceHandle[];
  /** Extra header names to redact in evidence, beyond the built-in list (§7.7). */
  redactExtraHeaders?: string[];
}

/** Executes a scenario's steps, in order, through the proxy (§7.1). */
export interface ScenarioClient {
  run(scenario: Scenario, ctx: RunContext): Promise<StepResult[]>;
}
