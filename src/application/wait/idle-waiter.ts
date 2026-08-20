import type { FailureCode } from "../../domain/failure.js";
import type { LayoutElement } from "../../domain/layout.js";
import type {
  AndroidCliPort,
  LayoutDiffObservation,
  LayoutDiffResult
} from "../../ports/android-cli.js";
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
      layout?: readonly LayoutElement[] | undefined;
      backend?:
        | "uiautomator"
        | "androidCli"
        | "gfxFrameStats"
        | undefined;
      samplingDurationMs?: number | undefined;
    }
  | {
      status: "timeout";
      code: Extract<FailureCode, "IDLE_TIMEOUT">;
      polls: number;
      durationMs: number;
      lastDiff: readonly unknown[];
      samplingDurationMs?: number | undefined;
    }
  | {
      status: "cancelled";
      polls: number;
      durationMs: number;
    };

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function normalizeObservation(
  result: LayoutDiffResult
): LayoutDiffObservation {
  return Array.isArray(result)
    ? { changes: result }
    : result as LayoutDiffObservation;
}

export class IdleWaiter {
  /**
   * Minimum remaining time (milliseconds) required to attempt a layout
   * diff confirmation poll.  When the remaining timeout budget is below
   * this threshold, the waiter declares stable without confirmation
   * rather than risking a partial confirmation poll.
   */
  private static readonly MIN_CONFIRMATION_BUDGET_MS = 1000;

  public constructor(
    private readonly androidCli: AndroidCliPort,
    private readonly clock: Clock,
    private readonly deviceSerial: string,
    private readonly packageName?: string
  ) {}

  public async waitUntilIdle(
    config: IdleConfig,
    signal?: AbortSignal
  ): Promise<IdleResult> {
    const startedAt = this.clock.now();
    let polls = 0;
    let consecutiveEmpty = 0;
    let lastDiff: readonly unknown[] = [];
    let lastLayout: readonly LayoutElement[] | undefined;
    let backend:
      | "uiautomator"
      | "androidCli"
      | "gfxFrameStats"
      | undefined;
    let needsLayoutConfirmation = false;
    let samplingDurationMs = 0;

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
      let observation: Awaited<ReturnType<AndroidCliPort["layoutDiff"]>>;
      try {
        observation = normalizeObservation(await this.androidCli.layoutDiff({
          deviceSerial: this.deviceSerial,
          ...(this.packageName === undefined
            ? {} : { packageName: this.packageName }),
          ...(signal === undefined ? {} : { signal }),
          timeoutMs: Math.max(1, config.timeoutMs - elapsedBeforePoll)
        }));
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
            lastDiff,
            samplingDurationMs
          };
        }
        throw error;
      }
      const diff = observation.changes;
      samplingDurationMs += observation.durationMs ?? 0;
      lastLayout = observation.layout ?? lastLayout;
      backend = observation.backend ?? backend;
      if (observation.backend === "gfxFrameStats") {
        needsLayoutConfirmation = true;
      }
      if (diff.length === 0) {
        consecutiveEmpty += 1;
      } else {
        consecutiveEmpty = 0;
        lastDiff = diff;
      }

      if (consecutiveEmpty >= config.stablePolls) {
        if (needsLayoutConfirmation) {
          const remaining = config.timeoutMs
            - (this.clock.now() - startedAt);
          if (remaining < IdleWaiter.MIN_CONFIRMATION_BUDGET_MS) {
            return {
              status: "stable",
              polls,
              durationMs: this.clock.now() - startedAt,
              ...(lastLayout === undefined ? {} : { layout: lastLayout }),
              ...(backend === undefined ? {} : { backend }),
              samplingDurationMs
            };
          }
          polls += 1;
          try {
            const confirm = normalizeObservation(
              await this.androidCli.layoutDiff({
                deviceSerial: this.deviceSerial,
                ...(signal === undefined ? {} : { signal }),
                timeoutMs: Math.max(1, remaining)
              })
            );
            samplingDurationMs += confirm.durationMs ?? 0;
            if (confirm.changes.length > 0) {
              consecutiveEmpty = 0;
              lastDiff = confirm.changes;
            } else {
              return {
                status: "stable",
                polls,
                durationMs: this.clock.now() - startedAt,
                ...(lastLayout === undefined ? {} : { layout: lastLayout }),
                ...(backend === undefined ? {} : { backend }),
                samplingDurationMs
              };
            }
          } catch (error) {
            const elapsed = this.clock.now() - startedAt;
            if (isAborted(signal)) {
              return {
                status: "cancelled",
                polls,
                durationMs: elapsed
              };
            }
            if (elapsed >= config.timeoutMs) {
              return {
                status: "timeout",
                code: "IDLE_TIMEOUT",
                polls,
                durationMs: elapsed,
                lastDiff,
                samplingDurationMs
              };
            }
            throw error;
          }
        } else {
          return {
            status: "stable",
            polls,
            durationMs: this.clock.now() - startedAt,
            ...(lastLayout === undefined ? {} : { layout: lastLayout }),
            ...(backend === undefined ? {} : { backend }),
            samplingDurationMs
          };
        }
      }

      if (this.clock.now() - startedAt >= config.timeoutMs) {
        return {
          status: "timeout",
          code: "IDLE_TIMEOUT",
          polls,
          durationMs: this.clock.now() - startedAt,
          lastDiff,
          samplingDurationMs
        };
      }

      const remainingMs = config.timeoutMs
        - (this.clock.now() - startedAt);
      if (remainingMs <= 0) {
        return {
          status: "timeout",
          code: "IDLE_TIMEOUT",
          polls,
          durationMs: this.clock.now() - startedAt,
          lastDiff,
          samplingDurationMs
        };
      }
      try {
        await this.clock.sleep(
          Math.min(config.pollIntervalMs, remainingMs),
          signal
        );
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
