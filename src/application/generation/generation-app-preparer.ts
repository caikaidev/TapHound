import { normalizeActivity } from "../../domain/activity.js";
import type { TapHoundConfig } from "../../domain/config.js";
import type { AdbPort } from "../../ports/adb.js";
import type { Clock } from "../../ports/clock.js";
import { ActivityWaiter } from "../runtime/activity-waiter.js";
import { launchFailure } from "../runtime/launch-failure.js";
import { ProcessWaiter } from "../runtime/process-waiter.js";

export interface GenerationAppPreparationInput {
  config: TapHoundConfig;
  deviceSerial: string;
  signal?: AbortSignal | undefined;
}

function commandFailure(result: {
  exitCode: number | null;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  spawnError?: string | undefined;
}): string | undefined {
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

export class GenerationAppPreparer {
  public constructor(
    private readonly adb: AdbPort,
    private readonly clock: Clock
  ) {}

  public async prepare(input: GenerationAppPreparationInput): Promise<void> {
    const identity = {
      packageName: input.config.run.packageName,
      deviceSerial: input.deviceSerial,
      timeoutMs: input.config.idle.timeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    };
    const stopped = await this.adb.forceStop(identity);
    const stopError = commandFailure(stopped);
    if (stopError !== undefined) {
      throw new Error(stopError);
    }

    const activity = normalizeActivity(
      input.config.run.packageName,
      input.config.run.activity
    );
    const launched = await this.adb.launchActivity({
      ...identity,
      activity
    });
    const launchError = launchFailure(launched);
    if (launchError !== undefined) {
      throw new Error(launchError);
    }

    const process = await new ProcessWaiter(this.adb, this.clock).wait({
      ...identity,
      pollIntervalMs: input.config.idle.pollIntervalMs
    });
    if (process.status !== "ready") {
      throw new Error(
        process.status === "cancelled"
          ? "App process readiness was cancelled"
          : "App process readiness timed out"
      );
    }

    const foreground = await new ActivityWaiter(this.adb, this.clock).wait({
      ...identity,
      expectedActivity: activity,
      pollIntervalMs: input.config.idle.pollIntervalMs
    });
    if (foreground.status !== "ready") {
      const actual = foreground.actual === undefined
        ? ""
        : `; last Activity was ${foreground.actual}`;
      throw new Error(
        foreground.status === "cancelled"
          ? `App Activity readiness was cancelled${actual}`
          : foreground.status === "processMissing"
            ? `App process exited before Activity readiness${actual}`
            : `App Activity readiness timed out${actual}`
      );
    }
  }
}
