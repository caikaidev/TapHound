import { normalizeActivity } from "../../domain/activity.js";
import type { TapHoundConfig } from "../../domain/config.js";
import type { Clock } from "../../ports/clock.js";
import {
  withRuntimeSession,
  type RuntimeSessionOpener
} from "../../ports/runtime-backend.js";
import type {
  RuntimeSessionPortViews,
  RuntimeSessionPortViewsFactory
} from "../../ports/runtime-session-ports.js";
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

export interface GenerationAppPreparerDependencies {
  sessions: RuntimeSessionOpener;
  sessionPorts: RuntimeSessionPortViewsFactory;
  clock: Clock;
}

export class GenerationAppPreparer {
  public constructor(
    private readonly dependencies: GenerationAppPreparerDependencies
  ) {}

  public prepare(input: GenerationAppPreparationInput): Promise<void> {
    return withRuntimeSession(
      this.dependencies.sessions,
      input.deviceSerial,
      input.signal,
      (session) => this.coldLaunch(
        this.dependencies.sessionPorts(session).adb,
        input
      )
    );
  }

  private async coldLaunch(
    adb: RuntimeSessionPortViews["adb"],
    input: GenerationAppPreparationInput
  ): Promise<void> {
    const identity = {
      packageName: input.config.run.packageName,
      deviceSerial: input.deviceSerial,
      timeoutMs: input.config.idle.timeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    };
    const stopped = await adb.forceStop(identity);
    const stopError = commandFailure(stopped);
    if (stopError !== undefined) {
      throw new Error(stopError);
    }

    const activity = normalizeActivity(
      input.config.run.packageName,
      input.config.run.activity
    );
    const launched = await adb.launchActivity({
      ...identity,
      activity
    });
    const launchError = launchFailure(launched);
    if (launchError !== undefined) {
      throw new Error(launchError);
    }

    const process = await new ProcessWaiter(adb, this.dependencies.clock).wait({
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
  }
}
