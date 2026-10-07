// Stable public surface (TWIN_ARCHITECTURE.md §10). Follow semver: adding a
// code is additive, renaming/removing one is a breaking change.
export type TwinErrorCode =
  | "E_NO_STACK"
  | "E_AMBIGUOUS_STACK"
  | "E_CONFIG_INVALID"
  | "E_SCENARIO_INVALID"
  | "E_UNSAFE_ENV"
  | "E_PORT_UNAVAILABLE"
  | "E_BUILD_FAILED"
  | "E_BOOT_TIMEOUT"
  | "E_BOOT_CRASH"
  | "E_CONTROL_FAILED"
  | "E_STEP_TIMEOUT"
  | "E_PROXY"
  | "E_TEARDOWN_PARTIAL"
  | "E_LOCKED"
  | "E_NO_REPORT"
  | "E_INTERNAL";

export interface TwinErrorOptions {
  /** What the user should try next. Shown alongside the message. */
  hint?: string;
  /** Extra machine-readable context (log paths, ports, etc). Never put secrets here (I5). */
  details?: Readonly<Record<string, unknown>>;
  /** Defaults to 2 ("Twin itself errored") per TWIN_CONTEXT.md §6. */
  exitCode?: number;
  cause?: unknown;
}

const DEFAULT_EXIT_CODE = 2;

/**
 * The one error class for user-facing failures. Rule (§10): never show a
 * stack trace by default; `message` must be plain English, `hint` must say
 * what to do about it.
 */
export class TwinError extends Error {
  readonly code: TwinErrorCode;
  readonly hint: string | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly exitCode: number;

  constructor(code: TwinErrorCode, message: string, options: TwinErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TwinError";
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
    this.exitCode = options.exitCode ?? DEFAULT_EXIT_CODE;
  }

  static isTwinError(value: unknown): value is TwinError {
    return value instanceof TwinError;
  }
}
