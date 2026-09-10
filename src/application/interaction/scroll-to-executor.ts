import type { FailureCode } from "../../domain/failure.js";
import type { JourneyStep } from "../../domain/journey.js";
import type { LayoutElement } from "../../domain/layout.js";
import type { DisplayViewport } from "../../domain/geometry.js";
import type { AnchorResolverPort } from "../../ports/anchor-resolver.js";
import type { UiSnapshotProvider } from "../../ports/ui-snapshot.js";
import { resolveLocator } from "../locator/locator-resolver.js";
import type {
  IdleBackend,
  IdleConfig,
  IdleStrategy,
  IdleWaiter
} from "../wait/idle-waiter.js";
import type { ActionExecutor } from "./action-executor.js";

export type ScrollToExecutionResult =
  | { status: "found"; swipesUsed: number; idleDurationMs: number }
  | {
    status: "failed";
    code: FailureCode;
    message: string;
    swipesUsed: number;
    idleDurationMs: number;
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
  | { status: "cancelled"; swipesUsed: number; idleDurationMs: number };

export interface ScrollToExecutorOptions {
  uiSnapshotProvider: UiSnapshotProvider;
  actionExecutor: Pick<ActionExecutor, "swipeBounds">;
  idleWaiter: Pick<IdleWaiter, "waitUntilIdle">;
  deviceSerial: string;
  idle: IdleConfig;
  anchorResolver?: AnchorResolverPort | undefined;
  readLayout?: (() => Promise<readonly LayoutElement[]>) | undefined;
  beforeSwipe?: (() => Promise<readonly LayoutElement[]>) | undefined;
  beforeMutation?: (() => Promise<void>) | undefined;
  requireLiveContainerCapability?: boolean | undefined;
  viewport?: (() => DisplayViewport | undefined) | undefined;
}

function isCancelled(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function callbackFailure(
  error: unknown,
  swipesUsed: number,
  idleDurationMs: number
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
      swipesUsed,
      idleDurationMs
    };
  }
  return undefined;
}

type ScrollTargetResolution =
  | {
    status: "found";
    element: LayoutElement;
    point: { x: number; y: number };
  }
  | { status: "failed"; code: FailureCode; message: string };

export class ScrollToExecutor {
  public constructor(private readonly options: ScrollToExecutorOptions) {}

  private async resolveTarget(
    step: Extract<JourneyStep, { action: "scrollTo" }>,
    layout: readonly LayoutElement[],
    signal?: AbortSignal
  ): Promise<ScrollTargetResolution> {
    if (step.anchor !== undefined) {
      const anchorResolver = this.options.anchorResolver;
      if (anchorResolver !== undefined) {
        const anchorResolution = await anchorResolver.resolve({
          anchorId: step.anchor,
          layout,
          ...(this.options.viewport === undefined
            ? {}
            : { viewport: this.options.viewport() }),
          ...(signal === undefined ? {} : { signal })
        });
        if (anchorResolution.status === "found") {
          const fallbackElement: LayoutElement = anchorResolution.element
            ?? {
                id: step.anchor,
                enabled: true,
                bounds: anchorResolution.bounds,
                children: []
              };
          return {
            status: "found",
            element: fallbackElement,
            point: anchorResolution.point ?? { x: 0, y: 0 }
          };
        }
        if (anchorResolution.status === "ambiguous") {
          return {
            status: "failed",
            code: "ANCHOR_AMBIGUOUS",
            message: anchorResolution.message
              ?? `Knowledge anchor ${step.anchor} resolved ambiguously`
          };
        }
      }
    }
    if (step.locator === undefined) {
      return {
        status: "failed",
        code: "ANCHOR_NOT_FOUND",
        message: `Knowledge anchor ${step.anchor ?? "(none)"} was not found and no locator fallback exists`
      };
    }
    const resolution = resolveLocator(
      layout,
      step.locator,
      { requireEnabled: false, viewport: this.options.viewport?.() }
    );
    if (resolution.status === "found") {
      return {
        status: "found",
        element: resolution.element,
        point: resolution.point
      };
    }
    return {
      status: "failed",
      code: resolution.code,
      message: resolution.message
    };
  }

  public async execute(
    step: Extract<JourneyStep, { action: "scrollTo" }>,
    signal?: AbortSignal,
    initialLayout?: readonly LayoutElement[]
  ): Promise<ScrollToExecutionResult> {
    let swipesUsed = 0;
    let idleDurationMs = 0;
    let layout = initialLayout;
    for (;;) {
      if (isCancelled(signal)) {
        return { status: "cancelled", swipesUsed, idleDurationMs };
      }
      try {
        layout ??= this.options.readLayout === undefined
          ? (await this.options.uiSnapshotProvider.capture({
              reason: "locate",
              freshness: "sameMutationEpoch",
              ...(signal === undefined ? {} : { signal }),
              timeoutMs: this.options.idle.timeoutMs
            })).roots
          : await this.options.readLayout();
      } catch (error) {
        const failed = callbackFailure(error, swipesUsed, idleDurationMs);
        if (failed !== undefined) return failed;
        throw error;
      }
      if (isCancelled(signal)) {
        return { status: "cancelled", swipesUsed, idleDurationMs };
      }
      const target = await this.resolveTarget(step, layout, signal);
      if (target.status === "found") {
        return { status: "found", swipesUsed, idleDurationMs };
      }
      if (
        target.code === "LOCATOR_AMBIGUOUS"
        || target.code === "ANCHOR_AMBIGUOUS"
      ) {
        return {
          status: "failed",
          code: target.code,
          message: target.message,
          swipesUsed,
          idleDurationMs
        };
      }
      if (swipesUsed >= step.maxSwipes) {
        return {
          status: "failed",
          code: "SCROLL_TARGET_NOT_FOUND",
          message: `Target not visible after ${String(step.maxSwipes)} swipes`,
          swipesUsed,
          idleDurationMs
        };
      }
      let container = resolveLocator(
        layout,
        step.container,
        { requireEnabled: false, viewport: this.options.viewport?.() }
      );
      if (container.status !== "found") {
        return {
          status: "failed",
          code: container.code,
          message: container.message,
          swipesUsed,
          idleDurationMs
        };
      }
      if (container.element.bounds === undefined) {
        return {
          status: "failed",
          code: "ACTION_FAILED",
          message: "scroll container has no bounds to swipe",
          swipesUsed,
          idleDurationMs
        };
      }
      if (this.options.beforeSwipe !== undefined) {
        try {
          layout = await this.options.beforeSwipe();
        } catch (error) {
          const failed = callbackFailure(error, swipesUsed, idleDurationMs);
          if (failed !== undefined) return failed;
          throw error;
        }
        if (isCancelled(signal)) {
          return { status: "cancelled", swipesUsed, idleDurationMs };
        }
        const liveTarget = await this.resolveTarget(step, layout, signal);
        if (liveTarget.status === "found") {
          return { status: "found", swipesUsed, idleDurationMs };
        }
        if (
          liveTarget.code === "LOCATOR_AMBIGUOUS"
          || liveTarget.code === "ANCHOR_AMBIGUOUS"
        ) {
          return {
            status: "failed",
            code: liveTarget.code,
            message: liveTarget.message,
            swipesUsed,
            idleDurationMs
          };
        }
        container = resolveLocator(
          layout,
          step.container,
          { requireEnabled: false, viewport: this.options.viewport?.() }
        );
        if (container.status !== "found") {
          return {
            status: "failed",
            code: container.code,
            message: container.message,
            swipesUsed,
            idleDurationMs
          };
        }
        if (container.element.bounds === undefined) {
          return {
            status: "failed",
            code: "ACTION_FAILED",
            message: "scroll container has no bounds to swipe",
            swipesUsed,
            idleDurationMs
          };
        }
      }
      if (isCancelled(signal)) {
        return { status: "cancelled", swipesUsed, idleDurationMs };
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
          swipesUsed,
          idleDurationMs
        };
      }
      try {
        await this.options.beforeMutation?.();
      } catch (error) {
        const failed = callbackFailure(error, swipesUsed, idleDurationMs);
        if (failed !== undefined) return failed;
        throw error;
      }
      if (isCancelled(signal)) {
        return { status: "cancelled", swipesUsed, idleDurationMs };
      }
      const swipe = await this.options.actionExecutor.swipeBounds(
        container.element.bounds,
        step.direction,
        step.distancePercent,
        step.durationMs,
        signal
      );
      if (isCancelled(signal)) {
        return { status: "cancelled", swipesUsed, idleDurationMs };
      }
      if (swipe.status === "failed") {
        return {
          status: "failed",
          code: swipe.code,
          message: swipe.message,
          swipesUsed,
          idleDurationMs
        };
      }
      const idle = await this.options.idleWaiter.waitUntilIdle(
        this.options.idle,
        signal
      );
      idleDurationMs += idle.durationMs;
      if (isCancelled(signal)) {
        return { status: "cancelled", swipesUsed, idleDurationMs };
      }
      if (idle.status === "cancelled") {
        return { status: "cancelled", swipesUsed, idleDurationMs };
      }
      if (idle.status === "timeout") {
        return {
          status: "failed",
          code: idle.code,
          message: "Layout did not become stable before timeout",
          swipesUsed,
          idleDurationMs,
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
