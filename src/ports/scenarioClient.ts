import type { Scenario } from "../domain/scenario.js";
import type { StepResult } from "../domain/stepResult.js";
import type { InstanceDriver, InstanceHandle } from "./instanceDriver.js";

/** Run-wide client settings, resolved by the CLI and forwarded by both phases. */
export interface ScenarioClientOptions {
  /** Extra header names to redact in evidence, beyond the built-in list (§7.7). */
  redactExtraHeaders?: string[];
  /**
   * Per-request deadline. Defaults to DEFAULT_REQUEST_TIMEOUT_MS. With
   * `retries`, each attempt gets the full budget, so a step's worst case is
   * (retries + 1) x this.
   */
  requestTimeoutMs?: number;
}

export interface RunContext extends ScenarioClientOptions {
  /** The proxy's base URL - every request step goes through this, never direct to an instance. */
  proxyUrl: string;
  instanceDriver: InstanceDriver;
  /**
   * Live and mutable: the Proxy reads instance state from this same array
   * reference, so a restart step must update it in place, not replace it.
   */
  instances: InstanceHandle[];
}

/** Executes a scenario's steps, in order, through the proxy (§7.1). */
export interface ScenarioClient {
  run(scenario: Scenario, ctx: RunContext): Promise<StepResult[]>;
}
