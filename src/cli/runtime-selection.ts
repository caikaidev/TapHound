import { resolve } from "node:path";

import {
  RuntimeBackendChoiceSchema,
  type RuntimeBackendChoice
} from "../domain/runtime.js";
import { CONFIG_PATH } from "../domain/workspace.js";

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

export class RuntimeBackendConfigError extends Error {
  public constructor(path: string, value: unknown) {
    super(
      `runtime.backend in ${path} must be one of ${
        RuntimeBackendChoiceSchema.options
          .map((option) => `"${option}"`)
          .join(", ")
      }, received ${typeof value === "string" ? `"${value}"` : String(value)}`
    );
    this.name = "RuntimeBackendConfigError";
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

function argvOptionValue(
  argv: readonly string[],
  name: string
): string | undefined {
  const prefix = `--${name}=`;
  let value: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === `--${name}` && argv[index + 1] !== undefined) {
      value = argv[index + 1] ?? undefined;
    } else if (argument.startsWith(prefix)) {
      value = argument.slice(prefix.length);
    }
  }
  return value;
}

function argvHasTarget(argv: readonly string[]): boolean {
  return argv.some((argument) => argument.startsWith("--target"));
}

export interface RuntimeBackendInvocation {
  env: Record<string, string | undefined>;
  argv: readonly string[];
  cwd: string;
  readConfigFile: (path: string) => Promise<string>;
}

async function configBackendChoice(
  invocation: RuntimeBackendInvocation
): Promise<RuntimeBackendChoice> {
  const project = argvOptionValue(invocation.argv, "project")
    ?? invocation.cwd;
  const configPath = resolve(
    project,
    argvOptionValue(invocation.argv, "config") ?? CONFIG_PATH
  );
  let text: string;
  try {
    text = await invocation.readConfigFile(configPath);
  } catch {
    // Local-target mode: the project config lives in the target workspace and
    // is not readable here. Keep the explicit local ADB choice for that path;
    // all other unreadable configs use the normal auto resolution.
    return argvHasTarget(invocation.argv) ? "adb" : "auto";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return "auto";
  }
  const backend = parsed === null || typeof parsed !== "object"
    ? undefined
    : (parsed as { runtime?: { backend?: unknown } }).runtime?.backend;
  if (backend === undefined) {
    return "auto";
  }
  const choice = RuntimeBackendChoiceSchema.safeParse(backend);
  if (!choice.success) {
    throw new RuntimeBackendConfigError(configPath, backend);
  }
  return choice.data;
}

/**
 * Resolves the effective runtime backend choice for one CLI invocation.
 * An explicit `TAPHOUND_RUNTIME_BACKEND` wins over the config file so CI and
 * experiments can override committed project state; `auto` defers to the
 * config's `runtime.backend`, which itself defaults to `auto`.
 */
export async function resolveRuntimeBackendChoiceFromInvocation(
  invocation: RuntimeBackendInvocation
): Promise<RuntimeBackendChoice> {
  const fromEnv = readRuntimeBackendChoice(invocation.env);
  if (fromEnv !== "auto") {
    return fromEnv;
  }
  return configBackendChoice(invocation);
}
