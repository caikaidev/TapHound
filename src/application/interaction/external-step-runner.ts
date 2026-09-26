import type { ExternalStep } from "../../domain/external-flow.js";
import type { FailureCode } from "../../domain/failure.js";
import type { DisplayViewport } from "../../domain/geometry.js";
import { JourneyStepSchema, type JourneyStep } from "../../domain/journey.js";
import type { LayoutElement } from "../../domain/layout.js";
import type { AdbPort } from "../../ports/adb.js";
import type { Clock } from "../../ports/clock.js";
import type { UiSnapshotProvider } from "../../ports/ui-snapshot.js";
import { elementPredicateMismatch } from "../assertion/expectation-evaluator.js";
import { resolveLocator } from "../locator/locator-resolver.js";
import { withIdleAdvice } from "../wait/idle-advice.js";
import type { IdleConfig, IdleResult, IdleWaiter } from "../wait/idle-waiter.js";
import type { ActionExecutor, ActionTarget } from "./action-executor.js";
import { ScrollToExecutor } from "./scroll-to-executor.js";

/**
 * The single implementation of External Flow steps and bridge foreground
 * polling shared by Replay and Generation, so a flow that generates also
 * replays under exactly the same rules.
 */

/** Foreground/layout observation budget inside an escaped app. */
export const EXTERNAL_OBSERVATION_TIMEOUT_MS = 5000;
const BRIDGE_POLL_INTERVAL_MS = 500;

export interface ExternalStepFailure {
  code: FailureCode;
  message: string;
  details?: unknown;
}

export type ExternalFlowOutcome =
  | { status: "passed" }
  | { status: "cancelled" }
  | ({ status: "failed"; stepIndex: number } & ExternalStepFailure);

export interface ExternalStepRunnerDependencies {
  adb: Pick<AdbPort, "foregroundComponent">;
  actionExecutor: ActionExecutor;
  uiSnapshotProvider: UiSnapshotProvider;
  captureLayout: (
    reason: "locate" | "expect",
    timeoutMs: number,
    signal?: AbortSignal
  ) => Promise<readonly LayoutElement[]>;
  createIdleWaiter: (packageName: string) => IdleWaiter;
  idle: IdleConfig;
  viewport: () => DisplayViewport | undefined;
  deviceSerial: string;
  /** Records idle-timeout evidence before the failure is reported. */
  onIdleTimeout?: ((
    stepIndex: number,
    idle: Extract<IdleResult, { status: "timeout" }>
  ) => Promise<void>) | undefined;
}

class ExternalStepStop extends Error {
  public constructor(
    public readonly failure: ExternalStepFailure | "cancelled"
  ) {
    super(failure === "cancelled" ? "cancelled" : failure.message);
  }
}

function stop(code: FailureCode, message: string, details?: unknown): never {
  throw new ExternalStepStop({
    code,
    message,
    ...(details === undefined ? {} : { details })
  });
}

function cancelled(): never {
  throw new ExternalStepStop("cancelled");
}

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) cancelled();
}

export function idleTimeoutDetails(
  idle: Extract<IdleResult, { status: "timeout" }>
): Record<string, unknown> {
  return {
    idle: {
      strategy: idle.strategy,
      ...(idle.backend === undefined ? {} : { backend: idle.backend }),
      polls: idle.polls,
      durationMs: idle.durationMs,
      samplingDurationMs: idle.samplingDurationMs,
      fallbackUsed: idle.fallbackUsed,
      frameActivityDetected: idle.frameActivityDetected,
      lastDiff: idle.lastDiff
    }
  };
}

export function externalStepToJourneyStep(step: ExternalStep): JourneyStep {
  const { expectedActivity, ...rest } = step;
  return JourneyStepSchema.parse({
    ...rest,
    activity: { before: expectedActivity, after: expectedActivity }
  });
}

function requireExternalTarget(
  layout: readonly LayoutElement[],
  step: ExternalStep,
  viewport: DisplayViewport | undefined
): ActionTarget | undefined {
  if (
    step.action !== "click"
    && step.action !== "longClick"
    && step.action !== "swipe"
  ) {
    return undefined;
  }
  const resolution = resolveLocator(layout, step.locator, {
    viewport,
    ...(step.action === "click" ? { requiredCapability: "clickable" as const } : {}),
    ...(step.action === "longClick"
      ? { requiredCapability: "longClickable" as const }
      : {})
  });
  if (resolution.status !== "found") {
    stop(resolution.code, resolution.message);
  }
  if (step.action === "click" && resolution.element.clickable !== true) {
    stop("ACTION_FAILED", "External click target is not clickable");
  }
  if (step.action === "longClick" && resolution.element.longClickable !== true) {
    stop("ACTION_FAILED", "External longClick target is not longClickable");
  }
  if (
    step.action === "swipe"
    && (resolution.element.scrollable !== true || resolution.element.bounds === undefined)
  ) {
    stop("ACTION_FAILED", "External swipe target lacks scrollable bounds");
  }
  return {
    point: resolution.point,
    ...(resolution.element.bounds === undefined
      ? {}
      : { bounds: resolution.element.bounds })
  };
}

export class ExternalStepRunner {
  public constructor(
    private readonly dependencies: ExternalStepRunnerDependencies
  ) {}

  public async run(
    steps: readonly ExternalStep[],
    escapedPackageName: string,
    signal?: AbortSignal
  ): Promise<ExternalFlowOutcome> {
    for (const [stepIndex, step] of steps.entries()) {
      try {
        checkCancelled(signal);
        await this.runStep(stepIndex, step, escapedPackageName, signal);
      } catch (error) {
        if (!(error instanceof ExternalStepStop)) throw error;
        return error.failure === "cancelled"
          ? { status: "cancelled" }
          : { status: "failed", stepIndex, ...error.failure };
      }
    }
    return { status: "passed" };
  }

  private async assertForeground(
    escapedPackageName: string,
    expectedActivity: string,
    phase: string,
    signal: AbortSignal | undefined
  ): Promise<void> {
    const foreground = await this.dependencies.adb.foregroundComponent({
      packageName: escapedPackageName,
      deviceSerial: this.dependencies.deviceSerial,
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: EXTERNAL_OBSERVATION_TIMEOUT_MS
    });
    checkCancelled(signal);
    if (foreground.packageName !== escapedPackageName) {
      stop(
        "EXTERNAL_PACKAGE_MISMATCH",
        `External app foreground changed ${phase}: expected "${escapedPackageName}", got "${foreground.packageName}"`
      );
    }
    if (foreground.activity !== expectedActivity) {
      stop(
        "EXTERNAL_ACTIVITY_MISMATCH",
        `External Activity mismatch ${phase}: expected "${expectedActivity}", got "${foreground.activity}"`
      );
    }
  }

  private async runStep(
    stepIndex: number,
    step: ExternalStep,
    escapedPackageName: string,
    signal: AbortSignal | undefined
  ): Promise<void> {
    const { dependencies } = this;
    await this.assertForeground(
      escapedPackageName,
      step.expectedActivity,
      "before the step",
      signal
    );
    const layout = await dependencies.captureLayout(
      "locate",
      EXTERNAL_OBSERVATION_TIMEOUT_MS,
      signal
    );
    checkCancelled(signal);

    if (step.action === "scrollTo") {
      const scroll = await new ScrollToExecutor({
        uiSnapshotProvider: dependencies.uiSnapshotProvider,
        actionExecutor: dependencies.actionExecutor,
        idleWaiter: dependencies.createIdleWaiter(escapedPackageName),
        deviceSerial: dependencies.deviceSerial,
        idle: dependencies.idle,
        viewport: dependencies.viewport,
        beforeSwipe: async (): Promise<readonly LayoutElement[]> => {
          await this.assertForeground(
            escapedPackageName,
            step.expectedActivity,
            "during scrolling",
            signal
          );
          return dependencies.captureLayout(
            "locate",
            EXTERNAL_OBSERVATION_TIMEOUT_MS,
            signal
          );
        },
        beforeMutation: (): Promise<void> => this.assertForeground(
          escapedPackageName,
          step.expectedActivity,
          "before mutation",
          signal
        ),
        requireLiveContainerCapability: true
      }).execute(
        externalStepToJourneyStep(step) as Extract<JourneyStep, { action: "scrollTo" }>,
        signal,
        layout
      );
      if (scroll.status === "cancelled") cancelled();
      if (scroll.status === "failed") {
        stop(
          scroll.code,
          scroll.message,
          scroll.idle === undefined ? undefined : { idle: scroll.idle }
        );
      }
    } else {
      const target = requireExternalTarget(layout, step, dependencies.viewport());
      const action = await dependencies.actionExecutor.execute(
        externalStepToJourneyStep(step),
        target,
        signal
      );
      if (action.status === "failed") stop(action.code, action.message);
    }

    const idle = await dependencies
      .createIdleWaiter(escapedPackageName)
      .waitUntilIdle(dependencies.idle, signal);
    if (idle.status === "cancelled") cancelled();
    if (idle.status === "timeout") {
      await dependencies.onIdleTimeout?.(stepIndex, idle);
      stop(
        idle.code,
        withIdleAdvice("External app layout did not become stable after step", idle),
        idleTimeoutDetails(idle)
      );
    }
    checkCancelled(signal);
    await this.evaluateExpect(step, escapedPackageName, signal);
  }

  private async evaluateExpect(
    step: ExternalStep,
    escapedPackageName: string,
    signal: AbortSignal | undefined
  ): Promise<void> {
    const expect = step.expect;
    if (expect === undefined) return;
    if (expect.type === "activity") {
      const foreground = await this.dependencies.adb.foregroundComponent({
        packageName: expect.packageName ?? escapedPackageName,
        deviceSerial: this.dependencies.deviceSerial,
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: expect.timeoutMs
      });
      checkCancelled(signal);
      if (foreground.activity !== expect.value) {
        stop(
          "EXTERNAL_STEP_FAILED",
          `External expect Activity mismatch: expected "${expect.value}", got "${foreground.activity}"`
        );
      }
      return;
    }
    if (expect.type !== "element") {
      stop(
        "EXTERNAL_STEP_FAILED",
        "Logcat expectations are not supported for external steps"
      );
    }
    const layout = await this.dependencies.captureLayout(
      "expect",
      expect.timeoutMs,
      signal
    );
    checkCancelled(signal);
    const resolution = resolveLocator(layout, expect.locator, {
      requireEnabled: false
    });
    if (expect.absent === true) {
      if (
        resolution.status !== "failed"
        || resolution.code !== "LOCATOR_NOT_FOUND"
        || resolution.evidenceMismatch === true
      ) {
        stop(
          "EXTERNAL_STEP_FAILED",
          resolution.status === "found"
            ? "External expect expected an absent element but it was found"
            : `External expect expected an absent element: ${resolution.message}`
        );
      }
      return;
    }
    if (resolution.status !== "found") {
      stop(
        "EXTERNAL_STEP_FAILED",
        `External expect element not found: ${resolution.message}`
      );
    }
    const mismatch = elementPredicateMismatch(resolution.element, expect);
    if (mismatch !== undefined) {
      stop(
        "EXTERNAL_STEP_FAILED",
        `External expect element predicate mismatch: ${mismatch}`
      );
    }
  }
}

export type ForegroundPollOutcome =
  | { status: "matched"; packageName: string }
  | { status: "timeout" }
  | { status: "cancelled" };

/**
 * Polls the foreground package until `until` accepts it: bridge escape
 * detection (`packageName !== target`) and return detection (`=== target`).
 */
export async function pollForegroundPackage(input: {
  adb: Pick<AdbPort, "foregroundComponent">;
  clock: Clock;
  packageName: string;
  deviceSerial: string;
  until: (packageName: string) => boolean;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}): Promise<ForegroundPollOutcome> {
  const deadline = input.clock.now() + input.timeoutMs;
  while (input.clock.now() < deadline) {
    if (input.signal?.aborted === true) return { status: "cancelled" };
    const foreground = await input.adb.foregroundComponent({
      packageName: input.packageName,
      deviceSerial: input.deviceSerial,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeoutMs: EXTERNAL_OBSERVATION_TIMEOUT_MS
    });
    if (input.until(foreground.packageName)) {
      return { status: "matched", packageName: foreground.packageName };
    }
    await input.clock.sleep(
      Math.min(BRIDGE_POLL_INTERVAL_MS, Math.max(0, deadline - input.clock.now())),
      input.signal
    );
  }
  return { status: "timeout" };
}

export interface BridgeRunDependencies {
  adb: Pick<AdbPort, "foregroundComponent">;
  clock: Clock;
  actionExecutor: ActionExecutor;
  externalSteps: ExternalStepRunner;
  idleWaiter: IdleWaiter;
  idle: IdleConfig;
  packageName: string;
  deviceSerial: string;
}

export interface BridgeRunInput {
  trigger: { step: JourneyStep; target: ActionTarget };
  escapeTimeoutMs: number;
  returnTimeoutMs: number;
  /** Engine policy for the escaped package; a failure stops the bridge. */
  acceptEscape: (escapedPackageName: string) => ExternalStepFailure | undefined;
  /** External steps to run inside the escaped app, if any. */
  externalSteps: (
    escapedPackageName: string
  ) => Promise<readonly ExternalStep[] | undefined>;
  signal?: AbortSignal | undefined;
}

export interface BridgeTiming {
  actionMs: number;
  waitMs: number;
}

export type BridgeOutcome =
  | {
      status: "returned";
      escapedPackageName: string;
      externalSteps?: readonly ExternalStep[] | undefined;
      idle: Extract<IdleResult, { status: "stable" }>;
      timing: BridgeTiming;
    }
  | ({
      status: "failed";
      idle?: Extract<IdleResult, { status: "timeout" }> | undefined;
      timing: BridgeTiming;
    } & ExternalStepFailure)
  | { status: "cancelled"; timing: BridgeTiming };

/**
 * The single bridge step flow for Replay and Generation: trigger, escape,
 * policy check, external steps, return, and settle.
 */
export class BridgeRunner {
  public constructor(private readonly dependencies: BridgeRunDependencies) {}

  public async run(input: BridgeRunInput): Promise<BridgeOutcome> {
    const { clock } = this.dependencies;
    const timing: BridgeTiming = { actionMs: 0, waitMs: 0 };
    const failed = (
      failure: ExternalStepFailure,
      idle?: Extract<IdleResult, { status: "timeout" }>
    ): BridgeOutcome => ({
      status: "failed",
      ...failure,
      ...(idle === undefined ? {} : { idle }),
      timing
    });
    const cancelledOutcome = (): BridgeOutcome => ({ status: "cancelled", timing });

    const actionStartedAt = clock.now();
    const action = await this.dependencies.actionExecutor.execute(
      input.trigger.step,
      input.trigger.target,
      input.signal
    );
    timing.actionMs = clock.now() - actionStartedAt;
    if (input.signal?.aborted === true) return cancelledOutcome();
    if (action.status === "failed") {
      return failed({ code: action.code, message: action.message });
    }

    const waitStartedAt = clock.now();
    const escaped = await pollForegroundPackage({
      adb: this.dependencies.adb,
      clock,
      packageName: this.dependencies.packageName,
      deviceSerial: this.dependencies.deviceSerial,
      until: (packageName) => packageName !== this.dependencies.packageName,
      timeoutMs: input.escapeTimeoutMs,
      signal: input.signal
    });
    timing.waitMs += clock.now() - waitStartedAt;
    if (escaped.status === "cancelled") return cancelledOutcome();
    if (escaped.status === "timeout") {
      return failed({
        code: "BRIDGE_NO_ESCAPE",
        message: "Bridge trigger did not cause a package escape"
      });
    }
    const rejected = input.acceptEscape(escaped.packageName);
    if (rejected !== undefined) return failed(rejected);

    const externalSteps = await input.externalSteps(escaped.packageName);
    if (externalSteps !== undefined) {
      const external = await this.dependencies.externalSteps.run(
        externalSteps,
        escaped.packageName,
        input.signal
      );
      if (external.status === "cancelled") return cancelledOutcome();
      if (external.status === "failed") {
        return failed({
          code: external.code,
          message: external.message,
          ...(external.details === undefined ? {} : { details: external.details })
        });
      }
    }

    const returnStartedAt = clock.now();
    const returned = await pollForegroundPackage({
      adb: this.dependencies.adb,
      clock,
      packageName: this.dependencies.packageName,
      deviceSerial: this.dependencies.deviceSerial,
      until: (packageName) => packageName === this.dependencies.packageName,
      timeoutMs: input.returnTimeoutMs,
      signal: input.signal
    });
    timing.waitMs += clock.now() - returnStartedAt;
    if (returned.status === "cancelled") return cancelledOutcome();
    if (returned.status === "timeout") {
      return failed({
        code: "BRIDGE_NOT_RETURNED",
        message: "Foreground did not return to target package within the timeout"
      });
    }

    const idleStartedAt = clock.now();
    const idle = await this.dependencies.idleWaiter.waitUntilIdle(
      this.dependencies.idle,
      input.signal
    );
    timing.waitMs += clock.now() - idleStartedAt;
    if (idle.status === "cancelled") return cancelledOutcome();
    if (idle.status === "timeout") {
      return failed({
        code: idle.code,
        message: withIdleAdvice(
          "Layout did not become stable after bridge return",
          idle
        ),
        details: idleTimeoutDetails(idle)
      }, idle);
    }
    return {
      status: "returned",
      escapedPackageName: escaped.packageName,
      ...(externalSteps === undefined ? {} : { externalSteps }),
      idle,
      timing
    };
  }
}
