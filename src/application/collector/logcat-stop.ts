import type { CommandResult } from "../../ports/process-runner.js";

export function logcatStopFailed(
  result: Pick<
    CommandResult,
    | "exitCode"
    | "signal"
    | "timedOut"
    | "cancelled"
    | "terminationRequested"
    | "spawnError"
  >
): boolean {
  if (
    result.timedOut
    || result.cancelled
    || result.spawnError !== undefined
  ) {
    return true;
  }
  return result.exitCode !== 0
    && !(
      result.terminationRequested === true
      && (
        result.signal === "SIGTERM"
        || result.signal === "SIGKILL"
      )
    );
}
