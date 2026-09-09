import type { FailureCode } from "../../domain/failure.js";

export interface RuntimeCapabilityError extends Error {
  code: FailureCode;
}

export function isRuntimeCapabilityError(
  error: unknown
): error is RuntimeCapabilityError {
  return (
    error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === "RUNTIME_CAPABILITY_MISSING"
  );
}

/**
 * Fail-closed rejection for capability-gated RuntimeSession members. The
 * error carries `RUNTIME_CAPABILITY_MISSING` so CLI consumers surface the
 * coded failure instead of a generic internal error, and the message names
 * the escape hatches that select a capable backend.
 */
export function runtimeCapabilityMissing(
  backendId: string,
  member: string
): RuntimeCapabilityError {
  const error = new Error(
    `Runtime backend "${backendId}" does not support ${member}. `
      + "Select a backend with this capability through runtime.backend in "
      + ".taphound/config.json or the TAPHOUND_RUNTIME_BACKEND environment "
      + 'variable (for example "adb").'
  ) as RuntimeCapabilityError;
  error.code = "RUNTIME_CAPABILITY_MISSING";
  return error;
}
