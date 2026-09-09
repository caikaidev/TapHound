import type { FailureCode } from "../../../domain/failure.js";

export class MobileMcpToolError extends Error {
  public override readonly name = "MobileMcpToolError";
  public readonly toolName: string;

  public constructor(toolName: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.toolName = toolName;
  }
}

export interface MobileMcpConnectError extends Error {
  code: FailureCode;
}

const SPAWN_FAILURE_MARKERS = ["ENOENT", "EACCES"] as const;

/**
 * Detects spawn-level failures ("spawn mcp-server-mobile ENOENT", EACCES,
 * ...) in either a raised error or a captured `CommandResult.spawnError`
 * string, so every consumer can offer the same remediation.
 */
export function isMobileMcpSpawnFailureDetail(detail: string): boolean {
  return SPAWN_FAILURE_MARKERS.some((marker) => detail.includes(marker));
}

export function mobileMcpServerUnavailableMessage(
  command: string,
  detail: string
): string {
  return `The Mobile MCP server command "${command}" is not available (${detail}). `
    + 'Install it with "npm install -g @mobilenext/mobile-mcp" and make sure '
    + `"${command}" is on PATH, or select the adb backend through `
    + "runtime.backend in .taphound/config.json or the "
    + "TAPHOUND_RUNTIME_BACKEND environment variable (for example \"adb\").";
}

/**
 * Wraps Mobile MCP server connection failures as coded
 * `ENVIRONMENT_MISSING_TOOL` errors. Spawn failures additionally explain how
 * to install the server or escape to the adb backend, so a missing
 * `mcp-server-mobile` binary never surfaces as a bare ENOENT.
 */
export function mobileMcpConnectError(
  command: string,
  cause: unknown
): MobileMcpConnectError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const message = isMobileMcpSpawnFailureDetail(detail)
    ? mobileMcpServerUnavailableMessage(command, detail)
    : `Failed to connect to the Mobile MCP server "${command}": ${detail}`;
  const error = new Error(message, { cause }) as MobileMcpConnectError;
  error.code = "ENVIRONMENT_MISSING_TOOL";
  return error;
}
