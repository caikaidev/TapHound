import type { FailureCode } from "../../domain/failure.js";
import type { JourneyStep } from "../../domain/journey.js";
import type { LayoutElement } from "../../domain/layout.js";
import type { AndroidCliPort } from "../../ports/android-cli.js";
import { resolveLocator } from "../locator/locator-resolver.js";
import type {
  IdleBackend,
  IdleConfig,
  IdleStrategy,
  IdleWaiter
} from "../wait/idle-waiter.js";
import type { ActionExecutor } from "./action-executor.js";

export type ScrollToExecutionResult =
  | { status: "found"; swipesUsed: number }
  | {
    status: "failed";
    code: FailureCode;
    message: string;
    swipesUsed: number;
    idle?: {
      polls: number;
      durationMs: number;
      samplingDurationMs: number;
      strategy: IdleStrategy;
      backend?: IdleBackend | undefined;
      fallbackUsed: boolean;
      frameActivityDetected: boolean;
      lastDiff: readonly unknown[];
    };
  }
  | { status: "cancelled"; swipesUsed: number };

export interface ScrollToExecutorOptions {
  androidCli: Pick<AndroidCliPort, "layout">;
  actionExecutor: Pick<ActionExecutor, "swipeBounds">;
  idleWaiter: Pick<IdleWaiter, "waitUntilIdle">;
  deviceSerial: string;
  idle: IdleConfig;
  readLayout?: (() => Promise<readonly LayoutElement[]>) | undefined;
  beforeSwipe?: (() => Promise<readonly LayoutElement[]>) | undefined;
  beforeMutation?: (() => Promise<void>) | undefined;
  requireLiveContainerCapability?: boolean | undefined;
}

function isCancelled(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function callbackFailure(
  error: unknown,
  swipesUsed: number
): Extract<ScrollToExecutionResult, { status: "failed" }> | undefined {
  if (
    error !== null
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    && [
      "ACTIVITY_BEFORE_MISMATCH",
      "ACTIVITY_AFTER_MISMATCH",
      "ACTION_FAILED"
    ].includes(error.code)
  ) {
    return {
      status: "failed",
      code: error.code as FailureCode,
      message: error instanceof Error ? error.message : error.code,
      swipesUsed
    };
  }
  return undefined;
}

export class ScrollToExecutor {
  public constructor(private readonly options: ScrollToExecutorOptions) {}

  public async execute(
    step: Extract<JourneyStep, { action: "scrollTo" }>,
    signal?: AbortSignal,
    initialLayout?: readonly LayoutElement[]
  ): Promise<ScrollToExecutionResult> {
    let swipesUsed = 0;
    let layout = initialLayout;
    for (;;) {
    if (isCancelled(signal)) {
        return { status: "cancelled", swipesUsed };
      }
      try {
        layout ??= this.options.readLayout === undefined
          ? await this.options.androidCli.layout({
              deviceSerial: this.options.deviceSerial,
              ...(signal === undefined ? {} : { signal }),
              timeoutMs: this.options.idle.timeoutMs
            })
          : await this.options.readLayout();
      } catch (error) {
        const failed = callbackFailure(error, swipesUsed);
        if (failed !== undefined) return failed;
        throw error;
      }
      if (isCancelled(signal)) {
        return { status: "cancelled", swipesUsed };
      }
      const target = resolveLocator(
        layout,
        step.locator,
        { requireEnabled: false }
      );
      if (target.status === "found") {
        return { status: "found", swipesUsed };
      }
      if (target.code === "LOCATOR_AMBIGUOUS") {
        return {
          status: "failed",
          code: "LOCATOR_AMBIGUOUS",
          message: target.message,
          swipesUsed
        };
      }
      if (swipesUsed >= step.maxSwipes) {
        return {
          status: "failed",
          code: "SCROLL_TARGET_NOT_FOUND",
          message: `Target not visible after ${String(step.maxSwipes)} swipes`,
          swipesUsed
        };
      }
      let container = resolveLocator(
        layout,
        step.container,
        { requireEnabled: false }
      );
      if (container.status !== "found") {
        return {
          status: "failed",
          code: container.code,
          message: container.message,
          swipesUsed
        };
      }
      if (container.element.bounds === undefined) {
        return {
          status: "failed",
          code: "ACTION_FAILED",
          message: "scroll container has no bounds to swipe",
          swipesUsed
        };
      }
      if (this.options.beforeSwipe !== undefined) {
        try {
          layout = await this.options.beforeSwipe();
        } catch (error) {
          const failed = callbackFailure(error, swipesUsed);
          if (failed !== undefined) return failed;
          throw error;
        }
        if (isCancelled(signal)) {
          return { status: "cancelled", swipesUsed };
        }
        const liveTarget = resolveLocator(
          layout,
          step.locator,
          { requireEnabled: false }
        );
        if (liveTarget.status === "found") {
          return { status: "found", swipesUsed };
        }
        if (liveTarget.code === "LOCATOR_AMBIGUOUS") {
          return {
            status: "failed",
            code: "LOCATOR_AMBIGUOUS",
            message: liveTarget.message,
            swipesUsed
          };
        }
        container = resolveLocator(
          layout,
          step.container,
          { requireEnabled: false }
        );
        if (container.status !== "found") {
          return {
            status: "failed",
            code: container.code,
            message: container.message,
            swipesUsed
          };
        }
        if (container.element.bounds === undefined) {
          return {
            status: "failed",
            code: "ACTION_FAILED",
            message: "scroll container has no bounds to swipe",
            swipesUsed
          };
        }
      }
      if (isCancelled(signal)) {
        return { status: "cancelled", swipesUsed };
      }
      if (
        this.options.requireLiveContainerCapability === true
        && (
          !container.element.enabled
          || container.element.scrollable !== true
        )
      ) {
        return {
          status: "failed",
          code: "ACTION_FAILED",
          message: "scroll container lost enabled scrollable bounds",
          swipesUsed
        };
      }
      try {
        await this.options.beforeMutation?.();
      } catch (error) {
        const failed = callbackFailure(error, swipesUsed);
        if (failed !== undefined) return failed;
        throw error;
      }
      if (isCancelled(signal)) {
        return { status: "cancelled", swipesUsed };
      }
      const swipe = await this.options.actionExecutor.swipeBounds(
        container.element.bounds,
        step.direction,
        step.distancePercent,
        step.durationMs,
        signal
      );
      if (isCancelled(signal)) {
        return { status: "cancelled", swipesUsed };
      }
      if (swipe.status === "failed") {
        return {
          status: "failed",
          code: swipe.code,
          message: swipe.message,
          swipesUsed
        };
      }
      const idle = await this.options.idleWaiter.waitUntilIdle(
        this.options.idle,
        signal
      );
      if (isCancelled(signal)) {
        return { status: "cancelled", swipesUsed };
      }
      if (idle.status === "cancelled") {
        return { status: "cancelled", swipesUsed };
      }
      if (idle.status === "timeout") {
        return {
          status: "failed",
          code: idle.code,
          message: "Layout did not become stable before timeout",
          swipesUsed,
          idle: {
            polls: idle.polls,
            durationMs: idle.durationMs,
            samplingDurationMs: idle.samplingDurationMs,
            strategy: idle.strategy,
            ...(idle.backend === undefined ? {} : { backend: idle.backend }),
            fallbackUsed: idle.fallbackUsed,
            frameActivityDetected: idle.frameActivityDetected,
            lastDiff: idle.lastDiff
          }
        };
      }
      swipesUsed += 1;
      layout = undefined;
    }
  }
}
