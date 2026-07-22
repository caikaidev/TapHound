import type { FailureCode } from "../../domain/failure.js";
import type { JourneyStep } from "../../domain/journey.js";
import type { LayoutElement } from "../../domain/layout.js";
import type { AndroidCliPort } from "../../ports/android-cli.js";
import { resolveLocator } from "../locator/locator-resolver.js";
import type { IdleConfig, IdleWaiter } from "../wait/idle-waiter.js";
import type { ActionExecutor } from "./action-executor.js";

export type ScrollToExecutionResult =
  | { status: "found"; swipesUsed: number }
  | {
    status: "failed";
    code: FailureCode;
    message: string;
    swipesUsed: number;
    idle?: { polls: number; lastDiff: readonly unknown[] };
  }
  | { status: "cancelled"; swipesUsed: number };

export interface ScrollToExecutorOptions {
  androidCli: Pick<AndroidCliPort, "layout">;
  actionExecutor: Pick<ActionExecutor, "swipeBounds">;
  idleWaiter: Pick<IdleWaiter, "waitUntilIdle">;
  deviceSerial: string;
  idle: IdleConfig;
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
      if (signal?.aborted === true) {
        return { status: "cancelled", swipesUsed };
      }
      layout ??= await this.options.androidCli.layout({
        deviceSerial: this.options.deviceSerial,
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: this.options.idle.timeoutMs
      });
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
      const container = resolveLocator(
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
      const swipe = await this.options.actionExecutor.swipeBounds(
        container.element.bounds,
        step.direction,
        step.distancePercent,
        step.durationMs,
        signal
      );
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
      if (idle.status === "cancelled") {
        return { status: "cancelled", swipesUsed };
      }
      if (idle.status === "timeout") {
        return {
          status: "failed",
          code: idle.code,
          message: "Layout did not become stable before timeout",
          swipesUsed,
          idle: { polls: idle.polls, lastDiff: idle.lastDiff }
        };
      }
      swipesUsed += 1;
      layout = undefined;
    }
  }
}
