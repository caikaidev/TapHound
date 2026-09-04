import type { FailureCode } from "../../domain/failure.js";
import type { LayoutElement } from "../../domain/layout.js";
import type {
  UiStabilityObservation,
  UiStabilityProbe,
  UiStabilitySampleResult
} from "../../ports/ui-stability.js";
import type { Clock } from "../../ports/clock.js";

export type IdleStrategy = "hybrid" | "layoutDiff" | "frameStats" | "structural";
export type IdleBackend = "uiautomator" | "androidCli" | "gfxFrameStats";

const EARLY_BAIL_FRAME_CHANGES = 2;
const POST_FALLBACK_MIN_STABLE = 2;

export interface IdleConfig {
  strategy?: IdleStrategy | undefined;
  pollIntervalMs: number;
  stablePolls: number;
  timeoutMs: number;
}

interface IdleTelemetry {
  strategy: IdleStrategy;
  backend?: IdleBackend | undefined;
  fallbackUsed: boolean;
  frameActivityDetected: boolean;
  samplingDurationMs: number;
}

export type IdleResult =
  | {
      status: "stable";
      polls: number;
      durationMs: number;
      layout?: readonly LayoutElement[] | undefined;
      backend?: IdleBackend | undefined;
      strategy: IdleStrategy;
      fallbackUsed: boolean;
      frameActivityDetected: boolean;
      samplingDurationMs: number;
    }
  | {
      status: "timeout";
      code: Extract<FailureCode, "IDLE_TIMEOUT">;
      polls: number;
      durationMs: number;
      lastDiff: readonly unknown[];
      backend?: IdleBackend | undefined;
      strategy: IdleStrategy;
      fallbackUsed: boolean;
      frameActivityDetected: boolean;
      samplingDurationMs: number;
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
  result: UiStabilitySampleResult
): UiStabilityObservation {
  return Array.isArray(result)
    ? { changes: result }
    : result as UiStabilityObservation;
}

function telemetry(
  strategy: IdleStrategy,
  backend: IdleBackend | undefined,
  fallbackUsed: boolean,
  frameActivityDetected: boolean,
  samplingDurationMs: number
): IdleTelemetry {
  return {
    strategy,
    ...(backend === undefined ? {} : { backend }),
    fallbackUsed,
    frameActivityDetected,
    samplingDurationMs
  };
}

export class IdleWaiter {
  public constructor(
    private readonly stability: UiStabilityProbe,
    private readonly clock: Clock,
    private readonly deviceSerial: string,
    private readonly packageName?: string
  ) {}

  public async waitUntilIdle(
    config: IdleConfig,
    signal?: AbortSignal
  ): Promise<IdleResult> {
    this.stability.reset();
    const strategy = config.strategy ?? "hybrid";
    const startedAt = this.clock.now();
    let polls = 0;
    let consecutiveEmpty = 0;
    let consecutiveFrameChanges = 0;
    let lastDiff: readonly unknown[] = [];
    let lastLayout: readonly LayoutElement[] | undefined;
    let backend: IdleBackend | undefined;
    let fallbackUsed = false;
    let frameActivityDetected = false;
    let samplingDurationMs = 0;
    let useStructuralBackend = strategy === "layoutDiff"
      || strategy === "structural"
      || (strategy === "hybrid" && this.packageName === undefined);

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
      let observation: UiStabilityObservation;
      try {
        observation = normalizeObservation(await this.stability.sample({
          deviceSerial: this.deviceSerial,
          ...(useStructuralBackend
            ? { stabilityBackend: "uiautomator" as const }
            : this.packageName === undefined
              ? {}
              : {
                  packageName: this.packageName,
                  stabilityBackend: "frameStats" as const
                }),
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
            ...telemetry(
              strategy,
              backend,
              fallbackUsed,
              frameActivityDetected,
              samplingDurationMs
            )
          };
        }
        throw error;
      }

      const diff = observation.changes;
      samplingDurationMs += observation.durationMs ?? 0;
      lastLayout = observation.layout ?? lastLayout;
      backend = observation.backend ?? backend;
      if (observation.backend === "gfxFrameStats" && diff.length > 0) {
        frameActivityDetected = true;
        consecutiveFrameChanges += 1;
      } else {
        consecutiveFrameChanges = 0;
      }

      if (
        strategy === "hybrid"
        && !useStructuralBackend
        && consecutiveFrameChanges >= EARLY_BAIL_FRAME_CHANGES
      ) {
        useStructuralBackend = true;
        fallbackUsed = true;
        consecutiveEmpty = 0;
      } else if (useStructuralBackend) {
        consecutiveEmpty = diff.length === 0
          ? consecutiveEmpty + 1
          : 0;
        if (diff.length > 0) lastDiff = diff;
      } else if (diff.length === 0) {
        consecutiveEmpty += 1;
      } else {
        consecutiveEmpty = 0;
        lastDiff = diff;
      }

      const isPostFallback = fallbackUsed && strategy === "hybrid";
      const requiredStableObservations = useStructuralBackend
        ? (isPostFallback
          ? Math.max(POST_FALLBACK_MIN_STABLE, config.stablePolls - 1)
          : Math.max(2, config.stablePolls))
        : config.stablePolls;
      if (consecutiveEmpty >= requiredStableObservations) {
        if (strategy === "hybrid" && !useStructuralBackend) {
          useStructuralBackend = true;
          consecutiveEmpty = 0;
        } else {
          return {
            status: "stable",
            polls,
            durationMs: this.clock.now() - startedAt,
            ...(lastLayout === undefined ? {} : { layout: lastLayout }),
            ...telemetry(
              strategy,
              backend,
              fallbackUsed,
              frameActivityDetected,
              samplingDurationMs
            )
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
          ...telemetry(
            strategy,
            backend,
            fallbackUsed,
            frameActivityDetected,
            samplingDurationMs
          )
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
          ...telemetry(
            strategy,
            backend,
            fallbackUsed,
            frameActivityDetected,
            samplingDurationMs
          )
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
