import type { InstanceId } from "./instance.js";

export type CheckId = "session-survives-switch" | "data-consistency" | "file-consistency" | "restart-persistence" | (string & {});

export interface MultipartFieldSpec {
  /** A tiny generated file so scenarios don't need fixtures on disk. */
  generate: { name: string; content: string };
}

export interface RequestSpec {
  method: string;
  path: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  multipart?: MultipartFieldSpec;
  body?: string;
}

export interface Expectation {
  status?: number | number[];
  bodyContains?: string;
  /** JSONPath (a small subset: $.a.b, $.a[0]) -> expected value. */
  jsonPath?: Record<string, unknown>;
}

export interface RequestStep {
  kind: "request";
  id: string;
  /** Pin to an instance, or "any" for round-robin. Default "any". */
  via?: InstanceId | "any";
  /** Which client/cookie jar. Default "default". */
  as?: string;
  request: RequestSpec;
  expect?: Expectation;
  /** variableName -> JSONPath ("$.id") or "header:Name". */
  save?: Record<string, string>;
  /** Marks this as the assertion step of a check. */
  check?: CheckId;
  /** Step ids this assertion depends on; defaults to the nearest preceding mutating step. */
  after?: string[];
  settleMs?: number;
  retries?: number;
}

export interface RestartStep {
  kind: "restart";
  id: string;
  instance: InstanceId;
  mode?: "crash" | "graceful";
  disk?: "fresh" | "keep";
}

export interface WaitStep {
  kind: "wait";
  id: string;
  ms: number;
}

export type Step = RequestStep | RestartStep | WaitStep;

export interface Scenario {
  version: 1;
  name: string;
  clients?: string[];
  steps: Step[];
}
