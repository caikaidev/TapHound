import type { FailureCode } from "../../domain/failure.js";
import {
  appProcessPids,
  primaryAppPid
} from "../../domain/app-process.js";
import type { ExternalStep, JourneyStep } from "../../domain/journey.js";
import type { LayoutElement } from "../../domain/layout.js";
import type { DisplayViewport } from "../../domain/geometry.js";
import type {
  ReportFailure,
  StepReport
} from "../../domain/report.js";
import type { AdbPort, AppIdentity } from "../../ports/adb.js";
import type {
  AnnotatedScreenResolverPort
} from "../../ports/annotated-screen-resolver.js";
import type { AnchorResolverPort } from "../../ports/anchor-resolver.js";
import type { ArtifactSession } from "../../ports/artifact-store.js";
import type { Clock } from "../../ports/clock.js";
import type { ScreenshotPort } from "../../ports/screenshot.js";
import type { UiStabilityProbe } from "../../ports/ui-stability.js";
import type {
  CaptureUiSnapshotOptions,
  UiSnapshotProvider
} from "../../ports/ui-snapshot.js";
import type { LogcatCollector } from "../collector/logcat-collector.js";
import { captureLogcatEvent } from "../collector/logcat-event.js";
import { bindingName } from "../../domain/binding-reference.js";
import type { LogcatEventWindow } from "../../domain/logcat-event.js";
import { ActionExecutor, type ActionTarget } from "../interaction/action-executor.js";
import { FallbackResolver } from "../interaction/fallback-resolver.js";
import { ScrollToExecutor } from "../interaction/scroll-to-executor.js";
import {
  BridgeRunner,
  ExternalStepRunner
} from "../interaction/external-step-runner.js";
import {
  resolveLocator,
  type LocatorResolution
} from "../locator/locator-resolver.js";
import { resolveActionTarget } from "../interaction/action-target.js";
import {
  ExpectationEvaluator,
  type ExpectationObservationInput
} from "../assertion/expectation-evaluator.js";
import {
  GuardedExpectationObservations,
  settledExpectationForeground,
  type GuardedExpectationProbe
} from "../assertion/guarded-expectation.js";
import {
  IdleWaiter,
  type IdleConfig,
  type IdleResult
} from "../wait/idle-waiter.js";
import { deviceIdentityResolver } from "../wait/idle-profiles.js";
import { withIdleAdvice } from "../wait/idle-advice.js";
import {
  hasExactlyOneEnabledFocusedElement
} from "../generation/focused-input.js";

export interface StepRunnerOptions {
  adb: AdbPort;
  screenshots: ScreenshotPort;
  annotatedScreens: AnnotatedScreenResolverPort;
  uiStability: UiStabilityProbe;
  uiSnapshotProvider: UiSnapshotProvider;
  clock: Clock;
  logcat: LogcatCollector;
  artifacts: ArtifactSession;
  packageName: string;
  deviceSerial: string;
  deviceRole?: string | undefined;
  idle: IdleConfig;
  requireFocusedInput?: boolean;
  generatedReplayPolicy?: boolean | undefined;
  runStartedAt?: number | undefined;
  markers?: Map<string, number> | undefined;
  bindings?: Map<string, ReplayBinding> | undefined;
  manualReplay?: boolean | undefined;
  anchorResolver?: AnchorResolverPort | undefined;
}

export interface ReplayBinding {
  value: string;
  valueType: "string" | "integer" | "identifier";
  sourceStepIndex: number;
  window: LogcatEventWindow;
  startedAtMs: number;
  evidenceSha256: string;
}

const WAIT_UNTIL_POLL_INTERVAL_MS = 100;

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export type StepRunResult =
  | { status: "passed"; report: StepReport }
  | { status: "failed"; report: StepReport; failure: ReportFailure }
  | { status: "cancelled"; report: StepReport }
  | { status: "manualRequired"; report: StepReport };

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
  private readonly scrollToExecutor: ScrollToExecutor;
  private currentViewport: DisplayViewport | undefined;
  private readonly bindings: Map<string, ReplayBinding>;

  public constructor(private readonly options: StepRunnerOptions) {
    this.bindings = options.bindings ?? new Map<string, ReplayBinding>();
    this.actionExecutor = new ActionExecutor(
      options.adb,
      options.deviceSerial,
      (): void => options.uiSnapshotProvider.invalidate?.("beforeAction")
    );
    this.fallbackResolver = new FallbackResolver(
      options.screenshots,
      options.annotatedScreens,
      options.deviceSerial
    );
    this.idleWaiter = new IdleWaiter(
      options.uiStability,
      options.clock,
      options.deviceSerial,
      options.packageName,
      deviceIdentityResolver(options.adb, {
        packageName: options.packageName,
        deviceSerial: options.deviceSerial,
        timeoutMs: options.idle.timeoutMs
      })
    );
    this.expectationEvaluator = new ExpectationEvaluator(
      options.adb,
      options.uiSnapshotProvider,
      options.logcat,
      options.clock
    );
    this.scrollToExecutor = new ScrollToExecutor({
      uiSnapshotProvider: options.uiSnapshotProvider,
      actionExecutor: this.actionExecutor,
      idleWaiter: this.idleWaiter,
      deviceSerial: options.deviceSerial,
      idle: options.idle,
      viewport: (): DisplayViewport | undefined => this.currentViewport,
      ...(options.anchorResolver === undefined
        ? {}
        : { anchorResolver: options.anchorResolver }),
      ...(options.generatedReplayPolicy === true
        ? {
            readLayout: async (): Promise<readonly LayoutElement[]> => (
              this.captureGeneratedLayout(this.currentSignal)
            ),
            beforeMutation: async (): Promise<void> => {
              await this.assertGeneratedForeground(
                undefined,
                "ACTIVITY_BEFORE_MISMATCH",
                this.currentSignal
              );
            },
            requireLiveContainerCapability: true
          }
        : {})
    });
  }

  private readonly identity = (signal?: AbortSignal): {
    packageName: string;
    deviceSerial: string;
    signal?: AbortSignal;
    timeoutMs: number;
  } => ({
    packageName: this.options.packageName,
    deviceSerial: this.options.deviceSerial,
    ...(signal === undefined ? {} : { signal }),
    timeoutMs: this.options.idle.timeoutMs
  });

  private readonly primaryPid = async (
    identity: AppIdentity
  ): Promise<number | null> => {
    const processes = await this.options.adb.appProcesses(identity);
    this.options.logcat.scopeToPids(appProcessPids(processes));
    return primaryAppPid(processes, this.options.packageName);
  };

  private async generatedForeground(
    expectedActivity: string,
    code: "ACTIVITY_BEFORE_MISMATCH" | "ACTIVITY_AFTER_MISMATCH",
    signal?: AbortSignal
  ): Promise<{ packageName: string; activity: string }> {
    const foreground = await this.options.adb.foregroundComponent(
      this.identity(signal)
    );
    if (
      foreground.packageName !== this.options.packageName
      || foreground.activity !== expectedActivity
    ) {
      throw Object.assign(new Error(
        `Expected foreground ${this.options.packageName}/${expectedActivity}, found ${
          foreground.packageName
        }/${foreground.activity}`
      ), { code });
    }
    return foreground;
  }

  private async assertGeneratedForeground(
    expectedActivity?: string,
    code: "ACTIVITY_BEFORE_MISMATCH" | "ACTIVITY_AFTER_MISMATCH" =
      "ACTIVITY_BEFORE_MISMATCH",
    signal?: AbortSignal
  ): Promise<void> {
    await this.generatedForeground(
      expectedActivity ?? this.currentExpectedActivity,
      code,
      signal
    );
  }

  private currentExpectedActivity = "";
  private currentSignal: AbortSignal | undefined;

  private async captureLayout(
    reason: CaptureUiSnapshotOptions["reason"],
    timeoutMs: number,
    signal?: AbortSignal,
    freshness: CaptureUiSnapshotOptions["freshness"] = "sameMutationEpoch"
  ): Promise<readonly LayoutElement[]> {
    const snapshot = await this.options.uiSnapshotProvider.capture({
      reason,
      freshness,
      timeoutMs,
      ...(signal === undefined ? {} : { signal })
    });
    this.currentViewport = snapshot.viewport;
    return snapshot.roots;
  }

  /**
   * Generated Replay observes Expect under the process identity it replays:
   * every observation re-checks the foreground package and primary PID, and
   * a Layout is re-checked after capture at the post-action Activity.
   */
  private expectationProbe(
    expectedActivity: string,
    expectedPid: number
  ): GuardedExpectationProbe<{ layout: readonly LayoutElement[] }> {
    const guard = async (
      activity: string | undefined,
      input: ExpectationObservationInput,
      deadline: number
    ): Promise<string> => {
      const identity = (): ReturnType<StepRunner["identity"]> => ({
        packageName: this.options.packageName,
        deviceSerial: this.options.deviceSerial,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        timeoutMs: Math.max(1, deadline - this.options.clock.now())
      });
      const foreground = await this.options.adb.foregroundComponent(identity());
      if (
        foreground.packageName !== this.options.packageName
        || (activity !== undefined && foreground.activity !== activity)
      ) {
        throw new Error(`Generated Expect foreground changed to ${
          foreground.packageName
        }/${foreground.activity}`);
      }
      const pid = await this.primaryPid(identity());
      if (pid !== expectedPid) {
        throw new Error(`Generated Expect process changed from ${
          String(expectedPid)
        } to ${String(pid)}`);
      }
      return foreground.activity;
    };
    return {
      activity: (input): Promise<string> => guard(
        undefined,
        input,
        this.options.clock.now() + input.timeoutMs
      ),
      layout: async (input): Promise<{ layout: readonly LayoutElement[] }> => {
        const deadline = this.options.clock.now() + input.timeoutMs;
        await guard(expectedActivity, input, deadline);
        const layout = await this.captureLayout(
          "expect",
          Math.max(1, deadline - this.options.clock.now()),
          input.signal
        );
        await guard(expectedActivity, input, deadline);
        return { layout };
      }
    };
  }

  private async captureGeneratedLayout(
    signal?: AbortSignal,
    freshness: CaptureUiSnapshotOptions["freshness"] = "sameMutationEpoch"
  ): Promise<readonly LayoutElement[]> {
    await this.assertGeneratedForeground(
      this.currentExpectedActivity,
      "ACTIVITY_BEFORE_MISMATCH",
      signal
    );
    const layout = await this.captureLayout(
      "locate",
      this.options.idle.timeoutMs,
      signal,
      freshness
    );
    await this.assertGeneratedForeground(
      this.currentExpectedActivity,
      "ACTIVITY_BEFORE_MISMATCH",
      signal
    );
    return layout;
  }

  public async run(
    step: JourneyStep,
    index: number,
    signal?: AbortSignal
  ): Promise<StepRunResult> {
    const originalStep = step;
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
      logcatPath,
      ...(this.options.deviceRole === undefined
        ? {}
        : { device: this.options.deviceRole }),
      ...(step.replayMode !== undefined ? { replayMode: step.replayMode } : {})
    };

    const finish = async (
      status: StepRunResult["status"],
      failure?: ReportFailure
    ): Promise<StepRunResult> => {
      if (report.locator !== undefined) {
        const requested = originalStep.action === "bridge"
          ? originalStep.triggerLocator
          : "locator" in originalStep
            ? originalStep.locator
            : undefined;
        if (requested !== undefined) {
          report.locator.requested = requested;
        }
        if (report.locator.message !== undefined) {
          report.locator.message = this.redact(report.locator.message);
        }
      }
      if (report.expectation?.message !== undefined) {
        report.expectation.message = this.redact(report.expectation.message);
      }
      if (failure !== undefined) failure.message = this.redact(failure.message);
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
      if (status === "cancelled") {
        return { status, report };
      }
      if (status === "manualRequired") {
        return { status, report };
      }
      return { status: "passed", report };
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

    const identity = this.identity(signal);
    this.currentExpectedActivity = step.activity.before;
    this.currentSignal = signal;
    let before: string;
    try {
      before = this.options.generatedReplayPolicy === true
        ? (await this.generatedForeground(
            step.activity.before,
            "ACTIVITY_BEFORE_MISMATCH",
            signal
          )).activity
        : await this.options.adb.currentActivity(identity);
    } catch (error) {
      if (
        error !== null
        && typeof error === "object"
        && "code" in error
        && error.code === "ACTIVITY_BEFORE_MISMATCH"
      ) {
        return fail("ACTIVITY_BEFORE_MISMATCH", errorMessage(error));
      }
      throw error;
    }
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
    try {
      step = this.resolveStepBindings(step);
    } catch {
      return fail("EXPECT_LOGCAT_FAILED", "Replay binding is missing or invalid");
    }
    const generatedPid = this.options.generatedReplayPolicy === true
      ? await this.primaryPid(identity)
      : undefined;
    // The stable post-action Layout; generated Replay's first element Expect
    // observation reuses it after the post-action identity checks.
    let settledLayout: readonly LayoutElement[] | undefined;
    if (
      this.options.generatedReplayPolicy === true
      && generatedPid === null
    ) {
      return fail("APP_CRASHED", "Generated replay process is not running");
    }
    if (step.action === "wait" && step.markerId !== undefined) {
      const startedAtMs = this.options.clock.now();
      this.options.markers?.set(step.markerId, startedAtMs);
      report.marker = { id: step.markerId, startedAtMs };
    }

    let target: ActionTarget | undefined;
    if (step.action === "scrollTo") {
      const scroll = await this.scrollToExecutor.execute(step, signal);
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
          report.idle = idleStepReport({
            ...scroll.idle,
            status: "timeout",
            code: "IDLE_TIMEOUT"
          });
        }
        return fail(scroll.code, scroll.message);
      }
    } else if (step.action === "bridge") {
      if (this.options.manualReplay === false && step.replayMode !== "auto") {
        report.locator = { status: "notRun", fallbackUsed: false };
        return finish("manualRequired");
      }
      let layout: readonly LayoutElement[];
      try {
        layout = this.options.generatedReplayPolicy === true
          ? await this.captureGeneratedLayout(signal)
          : await this.captureLayout(
              "locate",
              this.options.idle.timeoutMs,
              signal
            );
      } catch (error) {
        if (
          error !== null
          && typeof error === "object"
          && "code" in error
          && error.code === "ACTIVITY_BEFORE_MISMATCH"
        ) {
          return fail("ACTIVITY_BEFORE_MISMATCH", errorMessage(error));
        }
        throw error;
      }
      const triggerResolution = resolveLocator(layout, step.triggerLocator, {
        requiredCapability: "clickable",
        viewport: this.currentViewport
      });
      if (triggerResolution.status !== "found") {
        report.locator = {
          status: "failed",
          requested: step.triggerLocator,
          fallbackUsed: false,
          message: triggerResolution.message
        };
        return fail(triggerResolution.code, triggerResolution.message);
      }
      if (triggerResolution.element.clickable !== true) {
        return fail("ACTION_FAILED", "bridge trigger target is not clickable");
      }
      const triggerTarget: ActionTarget = {
        point: triggerResolution.point,
        ...(triggerResolution.element.bounds === undefined
          ? {}
          : { bounds: triggerResolution.element.bounds })
      };
      report.locator = {
        status: "found",
        requested: step.triggerLocator,
        matchedBy: triggerResolution.matchedBy,
        fallbackUsed: false
      };
      if (this.options.generatedReplayPolicy === true) {
        try {
          await this.assertGeneratedForeground(
            step.activity.before,
            "ACTIVITY_BEFORE_MISMATCH",
            signal
          );
        } catch (error) {
          return fail("ACTIVITY_BEFORE_MISMATCH", errorMessage(error));
        }
      }
      const recordedEscape = step.escapedPackageName;
      const bridge = await new BridgeRunner({
        adb: this.options.adb,
        clock: this.options.clock,
        actionExecutor: this.actionExecutor,
        externalSteps: this.externalStepRunner(index),
        idleWaiter: this.idleWaiter,
        idle: this.options.idle,
        packageName: this.options.packageName,
        deviceSerial: this.options.deviceSerial
      }).run({
        trigger: {
          step: {
            action: "click",
            locator: step.triggerLocator,
            activity: {
              before: step.activity.before,
              after: step.activity.before
            }
          },
          target: triggerTarget
        },
        escapeTimeoutMs: step.escapeTimeoutMs ?? 3000,
        returnTimeoutMs: step.returnTimeoutMs,
        // Replay must reach the same external app the Journey recorded.
        acceptEscape: (escapedPackageName) => (
          recordedEscape === undefined || escapedPackageName === recordedEscape
            ? undefined
            : {
                code: "EXTERNAL_PACKAGE_MISMATCH",
                message: `Bridge escaped to "${escapedPackageName}", but the Journey recorded "${recordedEscape}"`
              }
        ),
        external: {
          kind: "steps",
          steps: (): Promise<readonly ExternalStep[] | undefined> => (
            Promise.resolve(step.externalSteps)
          )
        },
        signal
      });
      if (bridge.status === "cancelled") {
        return finish("cancelled");
      }
      if (bridge.status === "failed") {
        if (bridge.idle !== undefined) {
          report.idle = idleStepReport(bridge.idle);
          await this.options.artifacts.writeJson(
            stepPath(index, "layout-diff.json"),
            bridge.idle.lastDiff
          );
        }
        return fail(bridge.code, bridge.message);
      }
      report.idle = idleStepReport(bridge.idle);
      settledLayout = bridge.idle.layout;
    } else if (
      step.action === "wait"
      && step.until !== undefined
      && step.timeoutMs !== undefined
    ) {
      const deadline = startedAt + step.timeoutMs;
      for (;;) {
        if (isAborted(signal)) {
          return finish("cancelled");
        }
        let layout: readonly LayoutElement[];
        try {
          layout = this.options.generatedReplayPolicy === true
            ? await this.captureGeneratedLayout(signal)
            : await this.captureLayout(
                "expect",
                Math.max(
                  1,
                  Math.min(
                    this.options.idle.timeoutMs,
                    deadline - this.options.clock.now()
                  )
                ),
                signal
              );
        } catch (error) {
          if (
            error !== null
            && typeof error === "object"
            && "code" in error
            && error.code === "ACTIVITY_BEFORE_MISMATCH"
          ) {
            return fail("ACTIVITY_BEFORE_MISMATCH", errorMessage(error));
          }
          throw error;
        }
        const resolution = resolveLocator(
          layout,
          step.until.element,
          { requireEnabled: false }
        );
        if (resolution.status === "found") {
          report.locator = {
            status: "found",
            requested: step.until.element,
            matchedBy: resolution.matchedBy,
            fallbackUsed: false
          };
          break;
        }
        if (this.options.clock.now() >= deadline) {
          report.locator = {
            status: "failed",
            requested: step.until.element,
            fallbackUsed: false,
            message: resolution.message
          };
          return fail(
            "WAIT_TIMEOUT",
            `Wait condition did not match before timeout: ${resolution.message}`
          );
        }
        try {
          await this.options.clock.sleep(
            WAIT_UNTIL_POLL_INTERVAL_MS,
            signal
          );
        } catch (error) {
          if (isAborted(signal)) {
            return finish("cancelled");
          }
          throw error;
        }
      }
    } else {
      let layout: readonly LayoutElement[];
      try {
        layout = this.options.generatedReplayPolicy === true
          ? await this.captureGeneratedLayout(signal)
          : await this.captureLayout(
              "locate",
              this.options.idle.timeoutMs,
              signal
            );
      } catch (error) {
        if (
          error !== null
          && typeof error === "object"
          && "code" in error
          && error.code === "ACTIVITY_BEFORE_MISMATCH"
        ) {
          return fail("ACTIVITY_BEFORE_MISMATCH", errorMessage(error));
        }
        throw error;
      }
      if (
        step.action === "click"
        || step.action === "longClick"
        || step.action === "swipe"
      ) {
        let anchorFallback: {
          status: "resolved" | "locatorFallback" | "failed";
          message?: string | undefined;
        } | undefined;
        if (step.anchor !== undefined) {
          const anchorResolver = this.options.anchorResolver;
          if (anchorResolver === undefined) {
            report.locator = {
              status: "failed",
              fallbackUsed: false,
              message: `Step targets Knowledge anchor ${step.anchor} but no anchor resolver is configured`
            };
            return fail(
              "ANCHOR_NOT_FOUND",
              `Step targets Knowledge anchor ${step.anchor} but no anchor resolver is configured`
            );
          }
          const anchorResolution = await anchorResolver.resolve({
            anchorId: step.anchor,
            layout,
            ...(this.currentViewport === undefined
              ? {}
              : { viewport: this.currentViewport }),
            ...(signal === undefined ? {} : { signal })
          });
          if (anchorResolution.status === "found") {
            target = {
              point: anchorResolution.point ?? {
                x: 0,
                y: 0
              },
              ...(anchorResolution.bounds === undefined
                ? {}
                : { bounds: anchorResolution.bounds })
            };
            report.locator = {
              status: "found",
              matchedBy: "anchor",
              anchorId: step.anchor,
              fallbackUsed: false,
              anchor: {
                status: "resolved",
                ...(anchorResolution.resolvedBy === undefined
                  ? {}
                  : { resolvedBy: anchorResolution.resolvedBy })
              }
            };
          } else if (step.locator === undefined) {
            report.locator = {
              status: "failed",
              anchorId: step.anchor,
              fallbackUsed: false,
              anchor: {
                status: "failed",
                ...(anchorResolution.message === undefined
                  ? {}
                  : { message: anchorResolution.message })
              },
              message: anchorResolution.message
            };
            return fail(
              "ANCHOR_NOT_FOUND",
              anchorResolution.message
                ?? `Knowledge anchor ${step.anchor} did not resolve`
            );
          } else {
            anchorFallback = {
              status: "locatorFallback",
              ...(anchorResolution.message === undefined
                ? {}
                : { message: anchorResolution.message })
            };
          }
        }
        if (target === undefined) {
        if (step.locator === undefined) {
          report.locator = {
            status: "failed",
            fallbackUsed: false,
            message: "Step has no runtime locator fallback"
          };
          return fail(
            "LOCATOR_NOT_FOUND",
            "Step has no runtime locator fallback"
          );
        }
        const locator = step.locator;
        const action = step.action;
        // Generated Replay targets exactly as Generation did; a recorded
        // Journey keeps the Recorder's element-center semantics.
        const locate = (): LocatorResolution => {
          if (this.options.generatedReplayPolicy !== true) {
            return resolveLocator(layout, locator, {
              viewport: this.currentViewport
            });
          }
          const resolved = resolveActionTarget(
            layout,
            action,
            locator,
            this.currentViewport
          );
          return resolved.status === "found" ? resolved.located : resolved;
        };
        let resolution = locate();
        const locatorDeadline = this.options.clock.now()
          + this.options.idle.timeoutMs;
        while (
          resolution.status !== "found"
          && resolution.code === "LOCATOR_NOT_FOUND"
          && resolution.evidenceMismatch !== true
          && this.options.clock.now() < locatorDeadline
        ) {
          try {
            await this.options.clock.sleep(
              Math.min(
                WAIT_UNTIL_POLL_INTERVAL_MS,
                locatorDeadline - this.options.clock.now()
              ),
              signal
            );
          } catch (error) {
            if (isAborted(signal)) {
              return finish("cancelled");
            }
            throw error;
          }
          if (isAborted(signal)) {
            return finish("cancelled");
          }
          try {
            layout = this.options.generatedReplayPolicy === true
              ? await this.captureGeneratedLayout(signal, "forceFresh")
              : await this.captureLayout(
                  "locate",
                  Math.max(1, locatorDeadline - this.options.clock.now()),
                  signal,
                  "forceFresh"
                );
          } catch (error) {
            if (
              error !== null
              && typeof error === "object"
              && "code" in error
              && error.code === "ACTIVITY_BEFORE_MISMATCH"
            ) {
              return fail("ACTIVITY_BEFORE_MISMATCH", errorMessage(error));
            }
            throw error;
          }
          resolution = locate();
        }
        if (resolution.status === "found") {
          target = {
            point: resolution.point,
            ...(resolution.element.bounds === undefined
              ? {}
              : { bounds: resolution.element.bounds })
          };
          report.locator = {
            status: "found",
            requested: step.locator,
            matchedBy: resolution.matchedBy,
            fallbackUsed: false,
            ...(step.anchor === undefined ? {} : { anchorId: step.anchor }),
            ...(anchorFallback === undefined
              ? {}
              : { anchor: { status: anchorFallback.status, ...(anchorFallback.message === undefined ? {} : { message: anchorFallback.message }) } })
          };
        } else {
          if (resolution.evidenceMismatch === true) {
            report.locator = {
              status: "failed",
              requested: step.locator,
              fallbackUsed: false,
              message: resolution.message
            };
            return fail(resolution.code, resolution.message);
          }
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
              requested: step.locator,
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
            requested: step.locator,
            fallbackUsed: true,
            fallbackLabel: fallback.label,
            annotatedScreenshotPath: annotatedPath
          };
        }
        }
      }

      if (
        step.action === "inputText"
        && step.anchor !== undefined
      ) {
        const anchorResolver = this.options.anchorResolver;
        if (anchorResolver === undefined) {
          report.locator = {
            status: "failed",
            fallbackUsed: false,
            message: `Step targets Knowledge anchor ${step.anchor} but no anchor resolver is configured`
          };
          return fail(
            "ANCHOR_NOT_FOUND",
            `Step targets Knowledge anchor ${step.anchor} but no anchor resolver is configured`
          );
        }
        const anchorResolution = await anchorResolver.resolve({
          anchorId: step.anchor,
          layout,
          ...(this.currentViewport === undefined
            ? {}
            : { viewport: this.currentViewport }),
          ...(signal === undefined ? {} : { signal })
        });
        if (anchorResolution.status !== "found") {
          report.locator = {
            status: "failed",
            anchorId: step.anchor,
            fallbackUsed: false,
            anchor: {
              status: "failed",
              ...(anchorResolution.message === undefined
                ? {}
                : { message: anchorResolution.message })
            },
            message: anchorResolution.message
          };
          return fail(
            anchorResolution.status === "ambiguous"
              ? "ANCHOR_AMBIGUOUS"
              : anchorResolution.status === "visualOnly"
                ? "RUNTIME_CAPABILITY_MISSING"
                : "ANCHOR_NOT_FOUND",
            anchorResolution.message
              ?? `Knowledge anchor ${step.anchor} did not resolve`
          );
        }
        if (anchorResolution.point === undefined) {
          report.locator = {
            status: "failed",
            anchorId: step.anchor,
            fallbackUsed: false,
            anchor: { status: "failed", message: "anchor element has no bounds" },
            message: "anchor element has no bounds"
          };
          return fail(
            "ANCHOR_NOT_FOUND",
            `Knowledge anchor ${step.anchor} resolved to an element without bounds`
          );
        }
        const tapped = await this.options.adb.tap(
          anchorResolution.point,
          this.options.deviceSerial,
          signal
        );
        if (tapped.exitCode !== 0) {
          return fail(
            "ACTION_FAILED",
            tapped.stderr.trim() || "Failed to focus the input anchor"
          );
        }
        target = {
          point: anchorResolution.point,
          ...(anchorResolution.bounds === undefined
            ? {}
            : { bounds: anchorResolution.bounds })
        };
        report.locator = {
          status: "found",
          matchedBy: "anchor",
          anchorId: step.anchor,
          fallbackUsed: false,
          anchor: {
            status: "resolved",
            ...(anchorResolution.resolvedBy === undefined
              ? {}
              : { resolvedBy: anchorResolution.resolvedBy })
          }
        };
        if (this.options.requireFocusedInput === true) {
          layout = await this.captureLayout("locate", this.options.idle.timeoutMs, signal);
        }
      }
      if (
        step.action === "inputText"
        && this.options.requireFocusedInput === true
        && !hasExactlyOneEnabledFocusedElement(layout)
      ) {
        return fail(
          "ACTION_FAILED",
          "inputText requires exactly one enabled focused Layout element"
        );
      }
      if (this.options.generatedReplayPolicy === true) {
        try {
          await this.assertGeneratedForeground(
            step.activity.before,
            "ACTIVITY_BEFORE_MISMATCH",
            signal
          );
        } catch (error) {
          return fail("ACTIVITY_BEFORE_MISMATCH", errorMessage(error));
        }
      }
      const action = await this.actionExecutor.execute(step, target, signal);
      if (action.status === "failed") {
        return fail(action.code, action.message);
      }

      const idle = await this.idleWaiter.waitUntilIdle(this.options.idle, signal);
      report.idle = idleStepReport(idle);
      if (idle.status === "cancelled") {
        return finish("cancelled");
      }
      if (idle.status === "timeout") {
        await this.options.artifacts.writeJson(
          stepPath(index, "layout-diff.json"),
          idle.lastDiff
        );
        return fail(
          idle.code,
          withIdleAdvice("Layout did not become stable before timeout", idle)
        );
      }
      settledLayout = idle.layout;
    }

    const pid = await this.primaryPid(identity);
    if (pid === null) {
      return fail("APP_CRASHED", "App process is no longer running");
    }
    if (
      generatedPid !== undefined
      && generatedPid !== null
      && pid !== generatedPid
    ) {
      return fail("APP_CRASHED", "Generated replay process identity changed");
    }

    let after: string;
    try {
      after = this.options.generatedReplayPolicy === true
        ? (await this.generatedForeground(
            step.activity.after,
            "ACTIVITY_AFTER_MISMATCH",
            signal
          )).activity
        : await this.options.adb.currentActivity(identity);
    } catch (error) {
      if (
        error !== null
        && typeof error === "object"
        && "code" in error
        && error.code === "ACTIVITY_AFTER_MISMATCH"
      ) {
        return fail("ACTIVITY_AFTER_MISMATCH", errorMessage(error));
      }
      throw error;
    }
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
      const observations = generatedPid === undefined || generatedPid === null
        ? undefined
        : new GuardedExpectationObservations(
            this.expectationProbe(step.activity.after, generatedPid),
            settledLayout === undefined ? undefined : { layout: settledLayout }
          );
      const expectation = await this.expectationEvaluator.evaluate(
        step.expect,
        {
          packageName: this.options.packageName,
          deviceSerial: this.options.deviceSerial,
          stepStartedAt: startedAt,
          ...(this.options.runStartedAt === undefined
            ? {}
            : { runStartedAt: this.options.runStartedAt }),
          ...(this.options.markers === undefined
            ? {}
            : { markers: this.options.markers })
        },
        signal,
        observations?.boundary() ?? {}
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
            status: "passed",
            ...(expectation.logcatEvent === undefined
              ? {}
              : { logcatEvent: expectation.logcatEvent })
          }
        : {
            type: expectation.type,
            status: "failed",
            code: expectation.code,
            message: expectation.message,
            ...(expectation.logcatEvent === undefined
              ? {}
              : { logcatEvent: expectation.logcatEvent })
          };
      if (expectation.status === "failed") {
        return fail(expectation.code, expectation.message);
      }
      const settled = settledExpectationForeground(
        step.expect,
        step.activity.after
      );
      if (this.options.generatedReplayPolicy === true && !settled.proven) {
        try {
          await this.assertGeneratedForeground(
            settled.activity,
            "ACTIVITY_AFTER_MISMATCH",
            signal
          );
          const guardedPid = await this.primaryPid(identity);
          if (guardedPid !== generatedPid) {
            return await fail(
              "ACTIVITY_AFTER_MISMATCH",
              "Generated replay process changed after Expect"
            );
          }
        } catch (error) {
          return fail("ACTIVITY_AFTER_MISMATCH", errorMessage(error));
        }
      }
      if (step.expect.type === "logcatEvent"
        && step.expect.capture !== undefined) {
        const line = this.expectationEvaluator.matchedEventFor(expectation);
        const evidence = expectation.logcatEvent;
        const value = line === undefined
          ? undefined
          : captureLogcatEvent(line, step.expect, step.expect.capture);
        if (value === undefined || evidence?.matchedLineSha256 === undefined
          || this.bindings.has(step.expect.capture.name)) {
          return fail("EXPECT_LOGCAT_FAILED", "Matched event Capture is invalid or duplicated");
        }
        this.bindings.set(step.expect.capture.name, {
          value,
          valueType: step.expect.capture.valueType,
          sourceStepIndex: index,
          window: evidence.window,
          startedAtMs: evidence.startedAtMs,
          evidenceSha256: evidence.matchedLineSha256
        });
        report.expectation.capture = {
          name: step.expect.capture.name,
          valueType: step.expect.capture.valueType,
          length: value.length,
          sourceStepIndex: index,
          window: evidence.window,
          startedAtMs: evidence.startedAtMs,
          evidenceSha256: evidence.matchedLineSha256
        };
      }
    }

    return finish("passed");
  }

  private redact(message: string): string {
    let sanitized = message;
    for (const { value } of this.bindings.values()) {
      sanitized = sanitized.replaceAll(value, "[bound value]");
    }
    return sanitized;
  }

  private resolveStepBindings(step: JourneyStep): JourneyStep {
    const lookup = (value: string): ReplayBinding | undefined => {
      const name = bindingName(value);
      if (name === undefined) return undefined;
      const binding = this.bindings.get(name);
      if (binding === undefined) throw new Error("Missing Replay binding");
      return binding;
    };
    const resolve = (value: string): string => {
      const binding = lookup(value);
      if (binding === undefined) return value;
      return binding.value;
    };
    let next = step;
    if (step.action === "inputText") {
      next = { ...step, text: resolve(step.text) };
    } else if ("locator" in step && step.locator?.text !== undefined) {
      next = { ...step, locator: { ...step.locator, text: resolve(step.locator.text) } };
    }
    if (step.expect?.type === "logcatEvent"
      && typeof step.expect.correlation?.value === "string") {
      next = {
        ...next,
        expect: {
          ...step.expect,
          correlation: {
            ...step.expect.correlation,
            value: lookup(step.expect.correlation.value)?.valueType === "integer"
              ? Number(resolve(step.expect.correlation.value))
              : resolve(step.expect.correlation.value)
          }
        }
      };
    }
    return next;
  }

  private externalStepRunner(stepIndex: number): ExternalStepRunner {
    return new ExternalStepRunner({
      adb: this.options.adb,
      actionExecutor: this.actionExecutor,
      uiSnapshotProvider: this.options.uiSnapshotProvider,
      captureLayout: (reason, timeoutMs, signal) => this.captureLayout(
        reason,
        timeoutMs,
        signal
      ),
      createIdleWaiter: (packageName: string): IdleWaiter => new IdleWaiter(
        this.options.uiStability,
        this.options.clock,
        this.options.deviceSerial,
        packageName,
        deviceIdentityResolver(this.options.adb, {
          packageName,
          deviceSerial: this.options.deviceSerial,
          timeoutMs: this.options.idle.timeoutMs
        })
      ),
      idle: this.options.idle,
      viewport: (): DisplayViewport | undefined => this.currentViewport,
      deviceSerial: this.options.deviceSerial,
      onIdleTimeout: async (externalIndex, idle): Promise<void> => {
        await this.options.artifacts.writeJson(
          stepPath(
            stepIndex,
            `external-${String(externalIndex + 1).padStart(3, "0")}-layout-diff.json`
          ),
          idle.lastDiff
        );
      }
    });
  }
}


function idleStepReport(idle: IdleResult): NonNullable<StepReport["idle"]> {
  if (idle.status === "cancelled") {
    return {
      status: "cancelled",
      polls: idle.polls,
      durationMs: idle.durationMs
    };
  }
  return idle.status === "timeout"
    ? {
        status: "timeout",
        polls: idle.polls,
        durationMs: idle.durationMs,
        samplingDurationMs: idle.samplingDurationMs,
        strategy: idle.strategy,
        ...(idle.backend === undefined ? {} : { backendId: idle.backend }),
        fallbackUsed: idle.fallbackUsed,
        frameActivityDetected: idle.frameActivityDetected,
        lastDiff: [...idle.lastDiff]
      }
    : {
        status: "stable",
        polls: idle.polls,
        durationMs: idle.durationMs,
        samplingDurationMs: idle.samplingDurationMs,
        ...(idle.backend === undefined ? {} : { backendId: idle.backend }),
        strategy: idle.strategy,
        fallbackUsed: idle.fallbackUsed,
        frameActivityDetected: idle.frameActivityDetected
      };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
