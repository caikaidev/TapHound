import type { FailureCode } from "../../domain/failure.js";
import type { JourneyStep } from "../../domain/journey.js";
import type { Bounds } from "../../domain/layout.js";
import type { AdbPort } from "../../ports/adb.js";
import type { Point } from "../../ports/android-cli.js";
import type { CommandResult } from "../../ports/process-runner.js";

export interface ActionTarget {
  point: Point;
  bounds?: Bounds | undefined;
}

export type ActionExecutionResult =
  | { status: "succeeded" }
  | {
      status: "failed";
      code: Extract<FailureCode, "ACTION_FAILED">;
      message: string;
    };

function failed(message: string): ActionExecutionResult {
  return {
    status: "failed",
    code: "ACTION_FAILED",
    message
  };
}

function commandResult(result: CommandResult): ActionExecutionResult {
  if (
    result.exitCode !== 0
    || result.timedOut
    || result.cancelled
    || result.spawnError !== undefined
  ) {
    return failed(result.stderr.trim() || "ADB Action failed");
  }
  return { status: "succeeded" };
}

function swipePoints(
  bounds: Bounds,
  direction: Extract<JourneyStep, { action: "swipe" }>["direction"],
  distancePercent: number
): { from: Point; to: Point } {
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  const horizontalDistance = (bounds.right - bounds.left) * distancePercent;
  const verticalDistance = (bounds.bottom - bounds.top) * distancePercent;

  const points = {
    up: {
      from: { x: centerX, y: centerY + verticalDistance / 2 },
      to: { x: centerX, y: centerY - verticalDistance / 2 }
    },
    down: {
      from: { x: centerX, y: centerY - verticalDistance / 2 },
      to: { x: centerX, y: centerY + verticalDistance / 2 }
    },
    left: {
      from: { x: centerX + horizontalDistance / 2, y: centerY },
      to: { x: centerX - horizontalDistance / 2, y: centerY }
    },
    right: {
      from: { x: centerX - horizontalDistance / 2, y: centerY },
      to: { x: centerX + horizontalDistance / 2, y: centerY }
    }
  } satisfies Record<string, { from: Point; to: Point }>;

  const selected = points[direction];
  return {
    from: {
      x: Math.round(selected.from.x),
      y: Math.round(selected.from.y)
    },
    to: {
      x: Math.round(selected.to.x),
      y: Math.round(selected.to.y)
    }
  };
}

export class ActionExecutor {
  public constructor(
    private readonly adb: AdbPort,
    private readonly deviceSerial: string
  ) {}

  public async execute(
    step: JourneyStep,
    target?: ActionTarget,
    signal?: AbortSignal
  ): Promise<ActionExecutionResult> {
    let result: CommandResult;
    switch (step.action) {
      case "click":
        if (target === undefined) {
          return failed("click requires a resolved target");
        }
        result = await this.adb.tap(target.point, this.deviceSerial, signal);
        break;
      case "longClick":
        if (target === undefined) {
          return failed("longClick requires a resolved target");
        }
        result = await this.adb.longClick(
          target.point,
          step.durationMs,
          this.deviceSerial,
          signal
        );
        break;
      case "inputText":
        result = await this.adb.inputText(
          step.text,
          this.deviceSerial,
          signal
        );
        break;
      case "swipe": {
        if (target === undefined) {
          return failed("swipe requires a resolved target");
        }
        if (target.bounds === undefined) {
          return failed("swipe requires target bounds from a scrollable element");
        }
        const points = swipePoints(
          target.bounds,
          step.direction,
          step.distancePercent
        );
        result = await this.adb.swipe(
          points.from,
          points.to,
          step.durationMs,
          this.deviceSerial,
          signal
        );
        break;
      }
      case "scrollTo":
        return failed("scrollTo is not executed via ActionExecutor");
      case "back":
        result = await this.adb.back(this.deviceSerial, signal);
        break;
      case "wait":
        return { status: "succeeded" };
    }

    return commandResult(result);
  }

  public async swipeBounds(
    bounds: Bounds,
    direction: Extract<JourneyStep, { action: "swipe" }>["direction"],
    distancePercent: number,
    durationMs: number,
    signal?: AbortSignal
  ): Promise<ActionExecutionResult> {
    const points = swipePoints(bounds, direction, distancePercent);
    const result = await this.adb.swipe(
      points.from,
      points.to,
      durationMs,
      this.deviceSerial,
      signal
    );
    return commandResult(result);
  }
}
