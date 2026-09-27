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
import { coldLaunchApp } from "../runtime/cold-launch.js";

export interface GenerationAppPreparationInput {
  config: TapHoundConfig;
  deviceSerial: string;
  signal?: AbortSignal | undefined;
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
    const launched = await coldLaunchApp(adb, this.dependencies.clock, {
      packageName: input.config.run.packageName,
      activity: normalizeActivity(
        input.config.run.packageName,
        input.config.run.activity
      ),
      deviceSerial: input.deviceSerial,
      pollIntervalMs: input.config.idle.pollIntervalMs,
      timeoutMs: input.config.idle.timeoutMs,
      signal: input.signal
    });
    if (launched.status === "cancelled") {
      throw new Error("App launch was cancelled");
    }
    if (launched.status === "failed") {
      throw new Error(launched.message);
    }
  }
}
