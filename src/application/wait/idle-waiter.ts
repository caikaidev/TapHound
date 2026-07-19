import type { FailureCode } from "../../domain/failure.js";
import type { AndroidCliPort } from "../../ports/android-cli.js";
import type { Clock } from "../../ports/clock.js";

export interface IdleConfig {
  pollIntervalMs: number;
  stablePolls: number;
  timeoutMs: number;
}

export type IdleResult =
  | {
      status: "stable";
      polls: number;
      durationMs: number;
    }
  | {
      status: "timeout";
      code: Extract<FailureCode, "IDLE_TIMEOUT">;
      polls: number;
      durationMs: number;
      lastDiff: readonly unknown[];
    }
  | {
      status: "cancelled";
      polls: number;
      durationMs: number;
    };

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export class IdleWaiter {
  public constructor(
    private readonly androidCli: AndroidCliPort,
    private readonly clock: Clock,
    private readonly deviceSerial: string
  ) {}

  public async waitUntilIdle(
    config: IdleConfig,
    signal?: AbortSignal
  ): Promise<IdleResult> {
    const startedAt = this.clock.now();
    let polls = 0;
    let consecutiveEmpty = 0;
    let lastDiff: readonly unknown[] = [];

    for (;;) {
      if (isAborted(signal)) {
        return {
          status: "cancelled",
          polls,
          durationMs: this.clock.now() - startedAt
        };
      }

      const elapsedBeforePoll = this.clock.now() - startedAt;
      polls += 1;
      let diff: readonly unknown[];
      try {
        diff = await this.androidCli.layoutDiff({
          deviceSerial: this.deviceSerial,
          ...(signal === undefined ? {} : { signal }),
          timeoutMs: Math.max(1, config.timeoutMs - elapsedBeforePoll)
        });
      } catch (error) {
        const elapsed = this.clock.now() - startedAt;
        if (isAborted(signal)) {
          return { status: "cancelled", polls, durationMs: elapsed };
        }
        if (elapsed >= config.timeoutMs) {
          return {
            status: "timeout",
            code: "IDLE_TIMEOUT",
            polls,
            durationMs: elapsed,
            lastDiff
          };
        }
        throw error;
      }
      if (diff.length === 0) {
        consecutiveEmpty += 1;
      } else {
        consecutiveEmpty = 0;
        lastDiff = diff;
      }

      if (consecutiveEmpty >= config.stablePolls) {
        return {
          status: "stable",
          polls,
          durationMs: this.clock.now() - startedAt
        };
      }

      if (this.clock.now() - startedAt >= config.timeoutMs) {
        return {
          status: "timeout",
          code: "IDLE_TIMEOUT",
          polls,
          durationMs: this.clock.now() - startedAt,
          lastDiff
        };
      }

      try {
        await this.clock.sleep(config.pollIntervalMs, signal);
      } catch (error) {
        if (isAborted(signal)) {
          return {
            status: "cancelled",
            polls,
            durationMs: this.clock.now() - startedAt
          };
        }
        throw error;
      }
    }
  }
}
