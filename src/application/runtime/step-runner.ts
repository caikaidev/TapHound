import type { FailureCode } from "../../domain/failure.js";
import type { JourneyStep } from "../../domain/journey.js";
import type {
  ReportFailure,
  StepReport
} from "../../domain/report.js";
import type { AdbPort } from "../../ports/adb.js";
import type { AndroidCliPort } from "../../ports/android-cli.js";
import type { ArtifactSession } from "../../ports/artifact-store.js";
import type { Clock } from "../../ports/clock.js";
import type { LogcatCollector } from "../collector/logcat-collector.js";
import { ActionExecutor, type ActionTarget } from "../interaction/action-executor.js";
import { FallbackResolver } from "../interaction/fallback-resolver.js";
import { resolveLocator } from "../locator/locator-resolver.js";
import { ExpectationEvaluator } from "../assertion/expectation-evaluator.js";
import { IdleWaiter, type IdleConfig } from "../wait/idle-waiter.js";

export interface StepRunnerOptions {
  adb: AdbPort;
  androidCli: AndroidCliPort;
  clock: Clock;
  logcat: LogcatCollector;
  artifacts: ArtifactSession;
  packageName: string;
  deviceSerial: string;
  idle: IdleConfig;
}

export type StepRunResult =
  | { status: "passed"; report: StepReport }
  | { status: "failed"; report: StepReport; failure: ReportFailure }
  | { status: "cancelled"; report: StepReport };

function stepPath(index: number, suffix: string): string {
  return `steps/${String(index + 1).padStart(3, "0")}-${suffix}`;
}

function targetForPoint(point: { x: number; y: number }): ActionTarget {
  return {
    point,
    bounds: {
      left: Math.max(0, point.x - 1),
      top: Math.max(0, point.y - 1),
      right: Math.max(1, point.x + 1),
      bottom: Math.max(1, point.y + 1)
    }
  };
}

export class StepRunner {
  private readonly actionExecutor: ActionExecutor;
  private readonly fallbackResolver: FallbackResolver;
  private readonly idleWaiter: IdleWaiter;
  private readonly expectationEvaluator: ExpectationEvaluator;

  public constructor(private readonly options: StepRunnerOptions) {
    this.actionExecutor = new ActionExecutor(options.adb, options.deviceSerial);
    this.fallbackResolver = new FallbackResolver(
      options.androidCli,
      options.deviceSerial
    );
    this.idleWaiter = new IdleWaiter(
      options.androidCli,
      options.clock,
      options.deviceSerial
    );
    this.expectationEvaluator = new ExpectationEvaluator(
      options.adb,
      options.androidCli,
      options.logcat,
      options.clock
    );
  }

  public async run(
    step: JourneyStep,
    index: number,
    signal?: AbortSignal
  ): Promise<StepRunResult> {
    const startedAt = this.options.clock.now();
    const logcatPath = stepPath(index, "logcat.txt");
    const activityReport: NonNullable<StepReport["activity"]> = {
      before: {
        status: "notRun",
        expected: step.activity.before
      },
      after: {
        status: "notRun",
        expected: step.activity.after
      }
    };
    const report: StepReport = {
      index,
      action: step.action,
      status: "notRun",
      startedAtMs: startedAt,
      finishedAtMs: startedAt,
      durationMs: 0,
      activity: activityReport,
      logcatPath
    };

    const finish = async (
      status: StepRunResult["status"],
      failure?: ReportFailure
    ): Promise<StepRunResult> => {
      const finishedAt = this.options.clock.now();
      report.finishedAtMs = finishedAt;
      report.durationMs = finishedAt - startedAt;
      report.status = status === "cancelled" ? "notRun" : status;
      const log = this.options.logcat
        .linesBetween(startedAt, finishedAt)
        .map((line) => line.raw)
        .join("\n");
      await this.options.artifacts.writeText(
        logcatPath,
        log.length === 0 ? "" : `${log}\n`
      );
      if (status === "failed" && failure !== undefined) {
        return { status, report, failure };
      }
      return status === "cancelled"
        ? { status, report }
        : { status: "passed", report };
    };

    const fail = async (
      code: FailureCode,
      message: string
    ): Promise<StepRunResult> => finish("failed", {
      code,
      message,
      phase: "replay",
      stepIndex: index
    });

    if (signal?.aborted === true) {
      return finish("cancelled");
    }

    const identity = {
      packageName: this.options.packageName,
      deviceSerial: this.options.deviceSerial,
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: this.options.idle.timeoutMs
    };
    const before = await this.options.adb.currentActivity(identity);
    activityReport.before = {
      status: before === step.activity.before ? "passed" : "failed",
      expected: step.activity.before,
      actual: before
    };
    if (before !== step.activity.before) {
      return fail(
        "ACTIVITY_BEFORE_MISMATCH",
        `Expected Activity ${step.activity.before}, found ${before}`
      );
    }

    let target: ActionTarget | undefined;
    if (step.action === "scrollTo") {
      const scroll = await this.resolveByScrolling(step, signal);
      report.scroll = {
        swipesUsed: scroll.swipesUsed,
        maxSwipes: step.maxSwipes
      };
      if (scroll.status === "cancelled") {
        return finish("cancelled");
      }
      if (scroll.status === "failed") {
        if (scroll.idle !== undefined) {
          await this.options.artifacts.writeJson(
            stepPath(index, "layout-diff.json"),
            scroll.idle.lastDiff
          );
          report.idle = {
            status: "timeout",
            polls: scroll.idle.polls,
            lastDiff: [...scroll.idle.lastDiff]
          };
        }
        return fail(scroll.code, scroll.message);
      }
    } else {
      const layout = await this.options.androidCli.layout({
        deviceSerial: this.options.deviceSerial,
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: this.options.idle.timeoutMs
      });
      if (
        step.action === "click"
        || step.action === "longClick"
        || step.action === "swipe"
      ) {
        const resolution = resolveLocator(layout, step.locator);
        if (resolution.status === "found") {
          target = {
            point: resolution.point,
            ...(resolution.element.bounds === undefined
              ? {}
              : { bounds: resolution.element.bounds })
          };
          report.locator = {
            status: "found",
            matchedBy: resolution.matchedBy,
            fallbackUsed: false
          };
        } else {
          const annotatedPath = stepPath(index, "fallback-annotated.png");
          const fallback = await this.fallbackResolver.resolve(
            step,
            this.options.artifacts.path(annotatedPath),
            signal
          );
          if (fallback.status !== "found") {
            const code = fallback.status === "failed"
              ? fallback.code
              : resolution.code;
            const message = fallback.status === "failed"
              ? fallback.message
              : resolution.message;
            report.locator = {
              status: "failed",
              fallbackUsed: fallback.status === "failed"
                && fallback.label !== undefined
                && fallback.annotatedScreenshotPath !== undefined,
              ...(fallback.status === "failed" && fallback.label !== undefined
                ? { fallbackLabel: fallback.label }
                : {}),
              ...(fallback.status === "failed"
                && fallback.annotatedScreenshotPath !== undefined
                ? { annotatedScreenshotPath: annotatedPath }
                : {}),
              message
            };
            return fail(code, message);
          }
          target = targetForPoint(fallback.point);
          report.locator = {
            status: "found",
            fallbackUsed: true,
            fallbackLabel: fallback.label,
            annotatedScreenshotPath: annotatedPath
          };
        }
      }

      const action = await this.actionExecutor.execute(step, target, signal);
      if (action.status === "failed") {
        return fail(action.code, action.message);
      }

      const idle = await this.idleWaiter.waitUntilIdle(this.options.idle, signal);
      report.idle = idle.status === "timeout"
        ? {
            status: "timeout",
            polls: idle.polls,
            lastDiff: [...idle.lastDiff]
          }
        : {
            status: idle.status,
            polls: idle.polls
          };
      if (idle.status === "cancelled") {
        return finish("cancelled");
      }
      if (idle.status === "timeout") {
        await this.options.artifacts.writeJson(
          stepPath(index, "layout-diff.json"),
          idle.lastDiff
        );
        return fail(idle.code, "Layout did not become stable before timeout");
      }
    }

    const pid = await this.options.adb.pid(identity);
    if (pid === null) {
      return fail("APP_CRASHED", "App process is no longer running");
    }

    const after = await this.options.adb.currentActivity(identity);
    activityReport.after = {
      status: after === step.activity.after ? "passed" : "failed",
      expected: step.activity.after,
      actual: after
    };
    if (after !== step.activity.after) {
      return fail(
        "ACTIVITY_AFTER_MISMATCH",
        `Expected Activity ${step.activity.after}, found ${after}`
      );
    }

    if (step.expect !== undefined) {
      const expectation = await this.expectationEvaluator.evaluate(
        step.expect,
        {
          packageName: this.options.packageName,
          deviceSerial: this.options.deviceSerial,
          stepStartedAt: startedAt
        },
        signal
      );
      if (expectation.status === "cancelled") {
        report.expectation = {
          type: expectation.type,
          status: "notRun"
        };
        return finish("cancelled");
      }
      report.expectation = expectation.status === "passed"
        ? {
            type: expectation.type,
            status: "passed"
          }
        : {
            type: expectation.type,
            status: "failed",
            code: expectation.code,
            message: expectation.message
          };
      if (expectation.status === "failed") {
        return fail(expectation.code, expectation.message);
      }
    }

    return finish("passed");
  }

  private async resolveByScrolling(
    step: Extract<JourneyStep, { action: "scrollTo" }>,
    signal?: AbortSignal
  ): Promise<
    | { status: "found"; swipesUsed: number }
    | {
        status: "failed";
        code: FailureCode;
        message: string;
        swipesUsed: number;
        idle?: { polls: number; lastDiff: readonly unknown[] };
      }
    | { status: "cancelled"; swipesUsed: number }
  > {
    let swipesUsed = 0;
    for (;;) {
      if (signal?.aborted === true) {
        return { status: "cancelled", swipesUsed };
      }
      const layout = await this.options.androidCli.layout({
        deviceSerial: this.options.deviceSerial,
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: this.options.idle.timeoutMs
      });
      const target = resolveLocator(layout, step.locator, { requireEnabled: false });
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
      const container = resolveLocator(layout, step.container, { requireEnabled: false });
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
      const swipe = await this.actionExecutor.swipeBounds(
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
      const idle = await this.idleWaiter.waitUntilIdle(this.options.idle, signal);
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
    }
  }
}
