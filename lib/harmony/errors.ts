export type HarmonyErrorCode =
  | "HDC_NOT_FOUND"
  | "HDC_INVALID"
  | "DEVICE_NOT_FOUND"
  | "DEVICE_OFFLINE"
  | "DEVICE_BUSY"
  | "LEASE_REQUIRED"
  | "LEASE_CONFLICT"
  | "LEASE_EXPIRED"
  | "STALE_SNAPSHOT"
  | "OBSERVATION_UNAVAILABLE"
  | "SCREEN_LOCKED"
  | "UI_TARGET_NOT_FOUND"
  | "UI_TARGET_AMBIGUOUS"
  | "AUTOMATION_DRIVER_UNAVAILABLE"
  | "AUTOMATION_DRIVER_FAILED"
  | "SCENARIO_FAILED"
  | "CAPABILITY_UNAVAILABLE"
  | "COMMAND_TIMEOUT"
  | "COMMAND_ABORTED"
  | "COMMAND_OUTPUT_LIMIT"
  | "COMMAND_FAILED"
  | "INVALID_ARGUMENT"
  | "INVALID_RESPONSE"
  | "INTERNAL_ERROR";

export interface HarmonyErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
  retryable?: boolean;
}

// Route modules and the long-lived device manager may be reloaded separately
// during development. Keep typed device errors recognizable across reloads.
const harmonyErrorBrand = Symbol.for("piora.harmony.error");

/**
 * Stable, serialization-safe error surfaced by the Harmony device subsystem.
 * Command arguments and captured device content are deliberately never stored.
 */
export class HarmonyError extends Error {
  readonly code: HarmonyErrorCode;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(code: HarmonyErrorCode, message: string, options: HarmonyErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HarmonyError";
    Object.defineProperty(this, harmonyErrorBrand, { value: true });
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isHarmonyError(value: unknown): value is HarmonyError {
  return value instanceof HarmonyError || Boolean(value && typeof value === "object"
    && (value as Record<symbol, unknown>)[harmonyErrorBrand] === true
    && typeof (value as HarmonyError).toJSON === "function");
}

export function asHarmonyError(value: unknown): HarmonyError {
  if (isHarmonyError(value)) return value;
  return new HarmonyError("INTERNAL_ERROR", "Harmony device operation failed unexpectedly", {
    cause: value,
  });
}
