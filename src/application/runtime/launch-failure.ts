import type { CommandResult } from "../../ports/process-runner.js";

const AM_START_ERROR = /^Error(:| type)/m;

export function launchFailure(result: CommandResult): string | undefined {
  if (result.spawnError !== undefined) {
    return result.spawnError;
  }
  if (result.timedOut) {
    return "App launch timed out";
  }
  if (result.cancelled) {
    return "App launch was cancelled";
  }
  if (result.exitCode !== 0) {
    return result.stderr.trim()
      || `App launch exited with code ${String(result.exitCode)}`;
  }
  const reported = result.stdout
    .split(/\r?\n/)
    .find((line) => AM_START_ERROR.test(line.trim()));
  return reported?.trim();
}
