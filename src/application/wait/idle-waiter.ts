import type { FailureCode } from "../../domain/failure.js";
import type { LayoutElement } from "../../domain/layout.js";
import type { DeviceIdleProfile } from "../../domain/config.js";
import type { DeviceIdentity } from "../../ports/adb.js";
import type {
  UiStabilityObservation,
  UiStabilityProbe,
  UiStabilitySampleResult
} from "../../ports/ui-stability.js";
import type { Clock } from "../../ports/clock.js";
import { resolveIdlePolicy } from "./idle-profiles.js";

export type IdleStrategy = "hybrid" | "layoutDiff" | "frameStats" | "structural";
export type IdleBackend = "uiautomator" | "androidCli" | "gfxFrameStats" | "mobileMcp";

const EARLY_BAIL_FRAME_CHANGES = 2;
const POST_FALLBACK_MIN_STABLE = 2;

export interface IdleConfig {
  strategy?: IdleStrategy | undefined;
  pollIntervalMs: number;
  stablePolls: number;
  timeoutMs: number;
  ignoreCursorBlink?: boolean | undefined;
  ignoreLayoutDrift?: boolean | undefined;
  deviceProfiles?: readonly DeviceIdleProfile[] | undefined;
}

function isEditableWidgetChange(change: unknown): boolean {
  if (typeof change !== "object" || change === null) {
    return false;
  }
  const record = change as Record<string, unknown>;
  const interactions = record.interactions;
  if (Array.isArray(interactions) && interactions.includes("EDITABLE")) {
    return true;
  }
  const cls = record.class;
  return typeof cls === "string" && cls.endsWith("EditText");
}

function meaningfulChanges(
  changes: readonly unknown[],
  ignoreCursorBlink: boolean
): readonly unknown[] {
  if (!ignoreCursorBlink) {
    return changes;
  }
  return changes.filter((change) => !isEditableWidgetChange(change));
}

function semanticKeys(change: unknown): string {
  if (typeof change !== "object" || change === null) {
    return JSON.stringify(change);
  }
  const record = change as Record<string, unknown>;
  const cls = typeof record.class === "string" ? record.class : "";
  const resourceId = typeof record["resource-id"] === "string"
    ? record["resource-id"]
    : "";
  const text = typeof record.text === "string" ? record.text : "";
  return `${cls}|${resourceId}|${text}`;
}

function sameKeySet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((key, index) => key === sortedRight[index]);
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
  private transientKeys: readonly string[] | undefined;

  public constructor(
    private readonly stability: UiStabilityProbe,
    private readonly clock: Clock,
    private readonly deviceSerial: string,
    private readonly packageName?: string,
    private readonly resolveDeviceIdentity?: (() => Promise<DeviceIdentity | undefined>) | undefined
  ) {}

  public async waitUntilIdle(
    input: IdleConfig,
    signal?: AbortSignal
  ): Promise<IdleResult> {
    this.stability.reset();
    this.transientKeys = undefined;
    const config = await this.effectiveConfig(input);
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
        let visibleChanges = meaningfulChanges(
          diff,
          config.ignoreCursorBlink === true
        );
        if (config.ignoreLayoutDrift === true && visibleChanges.length > 0) {
          const keys = visibleChanges.map(semanticKeys);
          if (
            this.transientKeys !== undefined
            && sameKeySet(this.transientKeys, keys)
          ) {
            visibleChanges = [];
          } else {
            this.transientKeys = keys;
          }
        } else if (config.ignoreLayoutDrift === true) {
          this.transientKeys = undefined;
        }
        consecutiveEmpty = visibleChanges.length === 0
          ? consecutiveEmpty + 1
          : 0;
        if (visibleChanges.length > 0) lastDiff = visibleChanges;
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

  private async effectiveConfig(input: IdleConfig): Promise<IdleConfig> {
    if (
      this.resolveDeviceIdentity === undefined
      || input.deviceProfiles === undefined
      || input.deviceProfiles.length === 0
    ) {
      return input;
    }
    const identity = await this.resolveDeviceIdentity();
    if (identity === undefined) {
      return input;
    }
    return resolveIdlePolicy(input, identity);
  }
}
