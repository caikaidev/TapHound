import type { AdbPort } from "../../ports/adb.js";
import type { Clock } from "../../ports/clock.js";

export interface ActivityWaitOptions {
  packageName: string;
  deviceSerial: string;
  expectedActivity: string;
  pollIntervalMs: number;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export type ActivityWaitResult =
  | { status: "ready"; actual: string; durationMs: number }
  | { status: "timeout"; actual?: string | undefined; durationMs: number }
  | {
      status: "processMissing";
      actual?: string | undefined;
      durationMs: number;
    }
  | { status: "cancelled"; actual?: string | undefined; durationMs: number };

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export class ActivityWaiter {
  public constructor(
    private readonly adb: AdbPort,
    private readonly clock: Clock
  ) {}

  public async wait(
    options: ActivityWaitOptions
  ): Promise<ActivityWaitResult> {
    const startedAt = this.clock.now();
    let actual: string | undefined;

    for (;;) {
      if (isAborted(options.signal)) {
        return {
          status: "cancelled",
          durationMs: this.clock.now() - startedAt,
          ...(actual === undefined ? {} : { actual })
        };
      }

      const elapsed = this.clock.now() - startedAt;
      if (elapsed >= options.timeoutMs) {
        return {
          status: "timeout",
          durationMs: elapsed,
          ...(actual === undefined ? {} : { actual })
        };
      }
      const commandTimeoutMs = Math.max(1, options.timeoutMs - elapsed);
      const identity = {
        packageName: options.packageName,
        deviceSerial: options.deviceSerial,
        timeoutMs: commandTimeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal })
      };

      if (await this.adb.pid(identity) === null) {
        return {
          status: "processMissing",
          durationMs: this.clock.now() - startedAt,
          ...(actual === undefined ? {} : { actual })
        };
      }

      actual = await this.adb.currentActivity(identity);
      if (actual === options.expectedActivity) {
        return {
          status: "ready",
          actual,
          durationMs: this.clock.now() - startedAt
        };
      }

      const elapsedAfterPoll = this.clock.now() - startedAt;
      if (elapsedAfterPoll >= options.timeoutMs) {
        return { status: "timeout", actual, durationMs: elapsedAfterPoll };
      }

      try {
        await this.clock.sleep(
          Math.min(
            options.pollIntervalMs,
            options.timeoutMs - elapsedAfterPoll
          ),
          options.signal
        );
      } catch (error) {
        if (isAborted(options.signal)) {
          return {
            status: "cancelled",
            actual,
            durationMs: this.clock.now() - startedAt
          };
        }
        throw error;
      }
    }
  }
}
