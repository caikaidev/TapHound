import type { AdbPort } from "../../ports/adb.js";
import type { Clock } from "../../ports/clock.js";
import type { CommandResult } from "../../ports/process-runner.js";
import { launchFailure } from "./launch-failure.js";
import { ProcessWaiter } from "./process-waiter.js";

export interface ColdLaunchInput {
  packageName: string;
  /** Fully qualified launch Activity. */
  activity: string;
  deviceSerial: string;
  pollIntervalMs: number;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export type ColdLaunchOutcome =
  | {
      status: "ready";
      pids: readonly number[];
      /** Time spent waiting for the process after the launch returned. */
      processWaitMs: number;
    }
  | {
      status: "failed";
      stage: "reset" | "launch" | "process";
      message: string;
    }
  | { status: "cancelled" };

/**
 * The one cold launch Replay, the Recorder, and Generation share: force-stop
 * the app, start its launch Activity, and wait until its process exists.
 */
export async function coldLaunchApp(
  adb: AdbPort,
  clock: Clock,
  input: ColdLaunchInput
): Promise<ColdLaunchOutcome> {
  const identity = {
    packageName: input.packageName,
    deviceSerial: input.deviceSerial,
    timeoutMs: input.timeoutMs,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  };
  const reset = resetFailure(await adb.forceStop(identity));
  if (reset !== undefined) {
    return { status: "failed", stage: "reset", message: reset };
  }
  const launch = launchFailure(await adb.launchActivity({
    ...identity,
    activity: input.activity
  }));
  if (launch !== undefined) {
    return { status: "failed", stage: "launch", message: launch };
  }
  const process = await new ProcessWaiter(adb, clock).wait({
    ...identity,
    pollIntervalMs: input.pollIntervalMs
  });
  if (process.status === "cancelled") {
    return { status: "cancelled" };
  }
  if (process.status === "timeout") {
    return {
      status: "failed",
      stage: "process",
      message: "App process was not found after launch"
    };
  }
  return {
    status: "ready",
    pids: process.pids,
    processWaitMs: process.durationMs
  };
}

function resetFailure(result: CommandResult): string | undefined {
  if (
    result.exitCode === 0
    && !result.timedOut
    && !result.cancelled
    && result.spawnError === undefined
  ) {
    return undefined;
  }
  return result.stderr.trim()
    || result.spawnError
    || (result.cancelled
      ? "App reset was cancelled"
      : result.timedOut
        ? "App reset timed out"
        : `App reset exited with code ${String(result.exitCode)}`);
}
