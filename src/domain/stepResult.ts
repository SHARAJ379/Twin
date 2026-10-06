import type { InstanceId } from "./instance.js";

/** Headers/body already passed through redaction (domain/redaction.ts) - safe to log, report, or paste publicly. */
export interface RedactedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyPreview?: string | undefined;
}

export interface RedactedResponse {
  status: number;
  headers: Record<string, string>;
  bodyPreview?: string | undefined;
}

export interface StepErrorInfo {
  message: string;
  code?: string | undefined;
}

export interface StepResult {
  stepId: string;
  instanceServed?: InstanceId | undefined;
  startedAt: number;
  durationMs: number;
  /** Absent for restart/wait steps - they have no HTTP request of their own. */
  request?: RedactedRequest | undefined;
  response?: RedactedResponse | undefined;
  error?: StepErrorInfo | undefined;
  expectationsPassed: boolean;
  failedExpectations: string[];
  /** Variables captured by this step's `save:`, after templating. */
  saved?: Record<string, string> | undefined;
}
