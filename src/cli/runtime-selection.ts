import {
  RuntimeBackendChoiceSchema,
  type RuntimeBackendChoice
} from "../domain/runtime.js";

export const RUNTIME_BACKEND_ENV_VAR = "TAPHOUND_RUNTIME_BACKEND";

export class RuntimeBackendSelectionError extends Error {
  public constructor(value: string) {
    super(
      `${RUNTIME_BACKEND_ENV_VAR} must be one of ${
        RuntimeBackendChoiceSchema.options
          .map((option) => `"${option}"`)
          .join(", ")
      }, received "${value}"`
    );
    this.name = "RuntimeBackendSelectionError";
  }
}

export function readRuntimeBackendChoice(
  env: Record<string, string | undefined>
): RuntimeBackendChoice {
  const raw = env[RUNTIME_BACKEND_ENV_VAR];
  if (raw === undefined || raw.trim() === "") {
    return "auto";
  }
  const value = raw.trim();
  const parsed = RuntimeBackendChoiceSchema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeBackendSelectionError(value);
  }
  return parsed.data;
}
