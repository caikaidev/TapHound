import { parse } from "node:path";

import { normalizeActivity } from "../../domain/activity.js";
import { primaryAppPid } from "../../domain/app-process.js";
import type { TapHoundConfig } from "../../domain/config.js";
import {
  ExternalStepSchema,
  JourneySchema,
  JourneyStepSchema,
  type ExternalStep,
  type Journey,
  type JourneyStep
} from "../../domain/journey.js";
import type { LayoutElement, Locator } from "../../domain/layout.js";
import type { AppIdentity, AdbPort } from "../../ports/adb.js";
import type { AndroidCliPort } from "../../ports/android-cli.js";
import type { Clock } from "../../ports/clock.js";
import type { JourneyWriterPort } from "../../ports/journey-writer.js";
import type {
  ExternalStepAction,
  RecorderAction,
  RecorderPromptPort
} from "../../ports/recorder-prompt.js";
import { ActionExecutor, type ActionTarget } from "../interaction/action-executor.js";
import { resolveLocator } from "../locator/locator-resolver.js";
import { launchFailure } from "../runtime/launch-failure.js";
import { ProcessWaiter } from "../runtime/process-waiter.js";
import { IdleWaiter } from "../wait/idle-waiter.js";
import {
  listLocatableTargets,
  listRecorderTargets,
  type RecorderTarget
} from "./locator-selector.js";

export interface RecorderDependencies {
  androidCli: AndroidCliPort;
  adb: AdbPort;
  clock: Clock;
  prompt: RecorderPromptPort;
  journeyWriter: JourneyWriterPort;
}

export interface RecordInput {
  config: TapHoundConfig;
  projectRoot: string;
  deviceSerial: string;
  journeyName: string;
  outputPath: string;
  signal?: AbortSignal | undefined;
}

export type RecordResult =
  | { status: "completed"; stepsRecorded: number; journey: Journey }
  | { status: "cancelled"; stepsRecorded: number }
  | { status: "failed"; stepsRecorded: number; message: string };

type ActionDraft =
  | { action: "click"; locator: Locator; fallback?: { type: "annotatedLabel"; label: string } }
  | { action: "longClick"; locator: Locator; durationMs: number; fallback?: { type: "annotatedLabel"; label: string } }
  | { action: "inputText"; text: string }
  | {
      action: "swipe";
      locator: Locator;
      direction: "up" | "down" | "left" | "right";
      distancePercent: number;
      durationMs: number;
    }
  | { action: "back" }
  | { action: "wait" }
  | {
      action: "scrollTo";
      locator: Locator;
      container: Locator;
      direction: "up" | "down" | "left" | "right";
      maxSwipes: number;
      distancePercent: number;
      durationMs: number;
    };

type BridgeRecordResult =
  | { status: "recorded"; step: JourneyStep }
  | { status: "skipped" }
  | { status: "failed"; message: string }
  | { status: "cancelled" };

type ExternalStepsResult =
  | { status: "recorded"; steps: ExternalStep[] }
  | { status: "cancelled" };

function failedCommand(result: {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  spawnError?: string | undefined;
}): boolean {
  return result.exitCode !== 0
    || result.timedOut
    || result.cancelled
    || result.spawnError !== undefined;
}

function commandMessage(
  result: { stderr: string; spawnError?: string | undefined },
  fallback: string
): string {
  return result.stderr.trim() || result.spawnError || fallback;
}

function annotatedPath(outputPath: string): string {
  const output = parse(outputPath);
  return `${output.dir}/${output.name}.annotated.png`;
}

function actionTarget(target?: RecorderTarget): ActionTarget | undefined {
  if (target === undefined) {
    return undefined;
  }
  const bounds = target.element.bounds;
  const point = target.element.center ?? (bounds === undefined
    ? undefined
    : {
        x: Math.round((bounds.left + bounds.right) / 2),
        y: Math.round((bounds.top + bounds.bottom) / 2)
      });
  if (point === undefined) {
    return undefined;
  }
  return {
    point,
    ...(bounds === undefined ? {} : { bounds })
  };
}

export class RecorderService {
  public constructor(private readonly dependencies: RecorderDependencies) {}

  public async record(input: RecordInput): Promise<RecordResult> {
    const launchActivity = normalizeActivity(
      input.config.run.packageName,
      input.config.run.activity
    );
    const identity = {
      packageName: input.config.run.packageName,
      deviceSerial: input.deviceSerial,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeoutMs: input.config.idle.timeoutMs
    };
    if (!await this.dependencies.adb.isInstalled(identity)) {
      return {
        status: "failed",
        stepsRecorded: 0,
        message: `Package ${input.config.run.packageName} is not installed on ${input.deviceSerial}`
      };
    }
    const stopped = await this.dependencies.adb.forceStop(identity);
    if (failedCommand(stopped)) {
      return {
        status: "failed",
        stepsRecorded: 0,
        message: commandMessage(stopped, "App reset failed")
      };
    }
    const launchError = launchFailure(
      await this.dependencies.adb.launchActivity({
        packageName: input.config.run.packageName,
        activity: launchActivity,
        deviceSerial: input.deviceSerial,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        timeoutMs: input.config.idle.timeoutMs
      })
    );
    if (launchError !== undefined) {
      return {
        status: "failed",
        stepsRecorded: 0,
        message: launchError
      };
    }
    const processReadiness = await new ProcessWaiter(
      this.dependencies.adb,
      this.dependencies.clock
    ).wait({
      packageName: input.config.run.packageName,
      deviceSerial: input.deviceSerial,
      pollIntervalMs: input.config.idle.pollIntervalMs,
      timeoutMs: input.config.idle.timeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    if (processReadiness.status === "cancelled") {
      return { status: "cancelled", stepsRecorded: 0 };
    }
    if (processReadiness.status === "timeout") {
      return {
        status: "failed",
        stepsRecorded: 0,
        message: "App process was not found after launch"
      };
    }

    const idleWaiter = new IdleWaiter(
      this.dependencies.androidCli,
      this.dependencies.clock,
      input.deviceSerial,
      input.config.run.packageName
    );
    await this.dependencies.androidCli.layout({
      deviceSerial: input.deviceSerial,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeoutMs: input.config.idle.timeoutMs
    });
    const startupIdle = await idleWaiter.waitUntilIdle(
      input.config.idle,
      input.signal
    );
    if (startupIdle.status === "cancelled") {
      return { status: "cancelled", stepsRecorded: 0 };
    }
    if (startupIdle.status === "timeout") {
      return {
        status: "failed",
        stepsRecorded: 0,
        message: "Layout did not become stable before timeout"
      };
    }

    const steps: JourneyStep[] = [];
    const executor = new ActionExecutor(
      this.dependencies.adb,
      input.deviceSerial
    );

    for (;;) {
      const layout = await this.dependencies.androidCli.layout({
        deviceSerial: input.deviceSerial,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        timeoutMs: input.config.idle.timeoutMs
      });
      const action = await this.dependencies.prompt.selectAction();
      if (action === "cancel") {
        return { status: "cancelled", stepsRecorded: steps.length };
      }
      if (action === "finish") {
        if (steps.length === 0) {
          return {
            status: "failed",
            stepsRecorded: 0,
            message: "Journey requires at least one successful step"
          };
        }
        const journey = JourneySchema.parse({
          version: 1,
          name: input.journeyName,
          steps
        });
        await this.dependencies.journeyWriter.write(input.outputPath, journey);
        return { status: "completed", stepsRecorded: steps.length, journey };
      }

      if (action === "bridgeTrigger") {
        const result = await this.recordBridgeStep(layout, input, identity);
        if (result.status === "cancelled") {
          return { status: "cancelled", stepsRecorded: steps.length };
        }
        if (result.status === "failed") {
          return {
            status: "failed",
            stepsRecorded: steps.length,
            message: result.message
          };
        }
        if (result.status === "recorded") {
          steps.push(result.step);
        }
        continue;
      }

      const prepared = await this.prepareAction(action, layout, input);
      if (prepared === undefined) {
        continue;
      }
      // scrollTo captures `before` post-scroll by design: it does not navigate, so before==after in practice (replay checks `before` pre-scroll but the Activity is unchanged).
      const before = normalizeActivity(
        input.config.run.packageName,
        await this.dependencies.adb.currentActivity(identity)
      );
      if (prepared.draft.action !== "scrollTo") {
        const execution = await executor.execute(
          prepared.draft as JourneyStep,
          actionTarget(prepared.target),
          input.signal
        );
        if (execution.status === "failed") {
          await this.dependencies.prompt.notifyFailure(execution.message);
          continue;
        }
        const idle = await idleWaiter.waitUntilIdle(input.config.idle, input.signal);
        if (idle.status !== "stable") {
          if (idle.status === "cancelled") {
            return { status: "cancelled", stepsRecorded: steps.length };
          }
          return {
            status: "failed",
            stepsRecorded: steps.length,
            message: "Layout did not become stable before timeout"
          };
        }
      }
      const processes = await this.dependencies.adb.appProcesses(identity);
      if (primaryAppPid(processes, input.config.run.packageName) === null) {
        return {
          status: "failed",
          stepsRecorded: steps.length,
          message: "App process crashed after the recorded Action"
        };
      }
      const after = normalizeActivity(
        input.config.run.packageName,
        await this.dependencies.adb.currentActivity(identity)
      );
      steps.push(JourneyStepSchema.parse({
        ...prepared.draft,
        activity: { before, after }
      }));
    }
  }

  private async prepareAction(
    action: Exclude<RecorderAction, "finish" | "cancel" | "bridgeTrigger">,
    layout: readonly LayoutElement[],
    input: RecordInput
  ): Promise<{ draft: ActionDraft; target?: RecorderTarget } | undefined> {
    if (action === "scrollTo") {
      return this.prepareScrollTo(layout, input);
    }
    if (action === "inputText") {
      return {
        draft: { action, text: await this.dependencies.prompt.inputText() }
      };
    }
    if (action === "back" || action === "wait") {
      return { draft: { action } };
    }

    const targets = listRecorderTargets(layout, action);
    if (targets.length === 0) {
      await this.dependencies.prompt.notifyFailure(
        "No enabled element has a unique deterministic Locator"
      );
      return undefined;
    }
    const selectedId = await this.dependencies.prompt.selectTarget(
      targets.map((target) => ({
        id: target.element.id,
        label: target.label
      }))
    );
    const target = targets.find((candidate) => candidate.element.id === selectedId);
    if (target === undefined) {
      await this.dependencies.prompt.notifyFailure("Selected Layout element is unavailable");
      return undefined;
    }

    if (action === "swipe") {
      const options = await this.dependencies.prompt.swipeOptions();
      return {
        target,
        draft: {
          action,
          locator: target.locator,
          direction: await this.dependencies.prompt.selectSwipeDirection(),
          ...options
        }
      };
    }

    let fallback: { type: "annotatedLabel"; label: string } | undefined;
    const screenshotPath = annotatedPath(input.outputPath);
    const capture = await this.dependencies.androidCli.captureScreen({
      outputPath: screenshotPath,
      annotate: true,
      deviceSerial: input.deviceSerial,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeoutMs: input.config.idle.timeoutMs
    });
    if (!failedCommand(capture)) {
      const label = await this.dependencies.prompt.selectFallbackLabel(screenshotPath);
      if (label !== undefined) {
        fallback = { type: "annotatedLabel", label };
      }
    }

    if (action === "click") {
      return {
        target,
        draft: {
          action,
          locator: target.locator,
          ...(fallback === undefined ? {} : { fallback })
        }
      };
    }
    return {
      target,
      draft: {
        action,
        locator: target.locator,
        durationMs: await this.dependencies.prompt.longClickDuration(),
        ...(fallback === undefined ? {} : { fallback })
      }
    };
  }

  private async prepareScrollTo(
    layout: readonly LayoutElement[],
    input: RecordInput,
    packageName: string = input.config.run.packageName,
    resourceIdOnly: boolean = false
  ): Promise<{ draft: ActionDraft; target?: RecorderTarget } | undefined> {
    const containers = listRecorderTargets(layout, "swipe").filter(
      (target) => !resourceIdOnly || target.locator.resourceId !== undefined
    );
    if (containers.length === 0) {
      await this.dependencies.prompt.notifyFailure(
        "No scrollable element has a unique deterministic Locator"
      );
      return undefined;
    }
    const containerId = await this.dependencies.prompt.selectScrollContainer(
      containers.map((c) => ({ id: c.element.id, label: c.label }))
    );
    const container = containers.find((c) => c.element.id === containerId);
    if (container === undefined) {
      await this.dependencies.prompt.notifyFailure("Selected container is unavailable");
      return undefined;
    }
    const direction = await this.dependencies.prompt.selectSwipeDirection();
    const options = await this.dependencies.prompt.swipeOptions();

    const executor = new ActionExecutor(this.dependencies.adb, input.deviceSerial);
    const idleWaiter = new IdleWaiter(
      this.dependencies.androidCli,
      this.dependencies.clock,
      input.deviceSerial,
      packageName
    );
    let currentLayout = layout;
    let swipesUsed = 0;
    for (;;) {
      const targets = listLocatableTargets(currentLayout).filter(
        (target) => !resourceIdOnly || target.locator.resourceId !== undefined
      );
      const decision = await this.dependencies.prompt.scrollTargetDecision(
        targets.map((t) => ({ id: t.element.id, label: t.label }))
      );
      if (decision.kind === "cancel") {
        return undefined;
      }
      if (decision.kind === "select") {
        const target = targets.find((t) => t.element.id === decision.id);
        if (target === undefined) {
          await this.dependencies.prompt.notifyFailure("Selected target is unavailable");
          return undefined;
        }
        return {
          target,
          draft: {
            action: "scrollTo",
            locator: target.locator,
            container: container.locator,
            direction,
            maxSwipes: Math.min(30, swipesUsed + 5),
            distancePercent: options.distancePercent,
            durationMs: options.durationMs
          }
        };
      }
      const resolved = resolveLocator(currentLayout, container.locator, {
        requireEnabled: false
      });
      if (resolved.status !== "found" || resolved.element.bounds === undefined) {
        await this.dependencies.prompt.notifyFailure("Scroll container disappeared");
        return undefined;
      }
      if (swipesUsed >= 30) {
        await this.dependencies.prompt.notifyFailure(
          "scrollTo reached the 30-swipe recording cap; the Journey would not replay"
        );
        return undefined;
      }
      const swipe = await executor.swipeBounds(
        resolved.element.bounds,
        direction,
        options.distancePercent,
        options.durationMs,
        input.signal
      );
      if (swipe.status === "failed") {
        await this.dependencies.prompt.notifyFailure(swipe.message);
        return undefined;
      }
      const idle = await idleWaiter.waitUntilIdle(input.config.idle, input.signal);
      if (idle.status !== "stable") {
        await this.dependencies.prompt.notifyFailure(
          "Layout did not become stable before timeout"
        );
        return undefined;
      }
      swipesUsed += 1;
      currentLayout = await this.dependencies.androidCli.layout({
        deviceSerial: input.deviceSerial,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        timeoutMs: input.config.idle.timeoutMs
      });
    }
  }

  private async recordBridgeStep(
    layout: readonly LayoutElement[],
    input: RecordInput,
    identity: AppIdentity
  ): Promise<BridgeRecordResult> {
    try {
      const scenario = await this.dependencies.prompt.selectBridgeScenario();
      const description = await this.dependencies.prompt.inputBridgeDescription(scenario);
      const returnTimeoutMs = await this.dependencies.prompt.inputBridgeReturnTimeoutMs();

      const targets = listRecorderTargets(layout, "click");
      if (targets.length === 0) {
        await this.dependencies.prompt.notifyFailure(
          "No clickable element has a unique deterministic Locator for the bridge trigger"
        );
        return { status: "skipped" };
      }
      const selectedId = await this.dependencies.prompt.selectTarget(
        targets.map((target) => ({
          id: target.element.id,
          label: target.label
        }))
      );
      const triggerTarget = targets.find(
        (candidate) => candidate.element.id === selectedId
      );
      if (triggerTarget === undefined) {
        await this.dependencies.prompt.notifyFailure(
          "Selected trigger element is unavailable"
        );
        return { status: "skipped" };
      }

      const before = normalizeActivity(
        input.config.run.packageName,
        await this.dependencies.adb.currentActivity(identity)
      );

      const executor = new ActionExecutor(
        this.dependencies.adb,
        input.deviceSerial
      );
      const triggerClick: Extract<JourneyStep, { action: "click" }> = {
        action: "click",
        locator: triggerTarget.locator,
        activity: { before, after: before }
      };
      const triggerExecution = await executor.execute(
        triggerClick,
        actionTarget(triggerTarget),
        input.signal
      );
      if (triggerExecution.status === "failed") {
        await this.dependencies.prompt.notifyFailure(triggerExecution.message);
        return { status: "skipped" };
      }

      const escapedPackageName = await this.pollBridgeEscape(identity, input);
      if (escapedPackageName === null) {
        await this.dependencies.prompt.notifyBridgeNoEscape();
        return { status: "skipped" };
      }
      await this.dependencies.prompt.notifyExternalEscape(escapedPackageName);

      const externalResult = await this.recordExternalSteps(input, escapedPackageName);
      if (externalResult.status === "cancelled") {
        return { status: "cancelled" };
      }
      const externalSteps = externalResult.steps;

      const returned = await this.pollBridgeReturn(identity, input, returnTimeoutMs);
      if (!returned) {
        return {
          status: "failed",
          message: "Foreground did not return to target package within the timeout"
        };
      }
      await this.dependencies.prompt.notifyExternalReturn();

      const idleWaiter = new IdleWaiter(
        this.dependencies.androidCli,
        this.dependencies.clock,
        input.deviceSerial,
        input.config.run.packageName
      );
      const idle = await idleWaiter.waitUntilIdle(input.config.idle, input.signal);
      if (idle.status === "cancelled") {
        return { status: "cancelled" };
      }
      if (idle.status === "timeout") {
        return {
          status: "failed",
          message: "Layout did not become stable before timeout"
        };
      }

      const processes = await this.dependencies.adb.appProcesses(identity);
      if (primaryAppPid(processes, input.config.run.packageName) === null) {
        return {
          status: "failed",
          message: "App process crashed after the recorded Action"
        };
      }

      const after = normalizeActivity(
        input.config.run.packageName,
        await this.dependencies.adb.currentActivity(identity)
      );

      const bridgeStep = JourneyStepSchema.parse({
        action: "bridge",
        scenario,
        description,
        triggerLocator: triggerTarget.locator,
        escapedPackageName,
        returnTimeoutMs,
        externalSteps,
        replayMode: "auto",
        activity: { before, after }
      });
      return { status: "recorded", step: bridgeStep };
    } catch (error) {
      if (input.signal?.aborted === true) {
        return { status: "cancelled" };
      }
      throw error;
    }
  }

  private async recordExternalSteps(
    input: RecordInput,
    escapedPackageName: string
  ): Promise<ExternalStepsResult> {
    const externalSteps: ExternalStep[] = [];
    const externalIdentity: AppIdentity = {
      packageName: escapedPackageName,
      deviceSerial: input.deviceSerial,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeoutMs: input.config.idle.timeoutMs
    };
    const externalIdleWaiter = new IdleWaiter(
      this.dependencies.androidCli,
      this.dependencies.clock,
      input.deviceSerial,
      escapedPackageName
    );
    const executor = new ActionExecutor(
      this.dependencies.adb,
      input.deviceSerial
    );

    for (;;) {
      const action = await this.dependencies.prompt.selectExternalStepAction();
      if (action === "finishExternal") {
        break;
      }

      const foreground = await this.dependencies.adb.foregroundComponent(
        externalIdentity
      );
      if (foreground.packageName !== escapedPackageName) {
        break;
      }
      const expectedActivity = foreground.activity;

      const layout = await this.dependencies.androidCli.layout({
        deviceSerial: input.deviceSerial,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        timeoutMs: input.config.idle.timeoutMs
      });

      const prepared = await this.prepareExternalStep(action, layout, input, escapedPackageName);
      if (prepared === undefined) {
        continue;
      }

      if (action !== "scrollTo") {
        const execution = await executor.execute(
          prepared.draft as JourneyStep,
          actionTarget(prepared.target),
          input.signal
        );
        if (execution.status === "failed") {
          await this.dependencies.prompt.notifyFailure(execution.message);
          continue;
        }

        const postForeground = await this.dependencies.adb.foregroundComponent(
          externalIdentity
        );
        if (postForeground.packageName !== escapedPackageName) {
          externalSteps.push(
            this.buildExternalStep(prepared.draft, expectedActivity)
          );
          break;
        }

        const idle = await externalIdleWaiter.waitUntilIdle(
          input.config.idle,
          input.signal
        );
        if (idle.status === "cancelled") {
          return { status: "cancelled" };
        }
        if (idle.status === "timeout") {
          await this.dependencies.prompt.notifyFailure(
            "External app layout did not become stable before timeout"
          );
          break;
        }
      }

      externalSteps.push(
        this.buildExternalStep(prepared.draft, expectedActivity)
      );
    }

    return { status: "recorded", steps: externalSteps };
  }

  private async prepareExternalStep(
    action: Exclude<ExternalStepAction, "finishExternal">,
    layout: readonly LayoutElement[],
    input: RecordInput,
    packageName: string
  ): Promise<{ draft: ActionDraft; target?: RecorderTarget } | undefined> {
    if (action === "scrollTo") {
      return this.prepareScrollTo(layout, input, packageName, true);
    }
    if (action === "inputText") {
      return {
        draft: { action, text: await this.dependencies.prompt.inputText() }
      };
    }
    if (action === "back" || action === "wait") {
      return { draft: { action } };
    }

    const targets = listRecorderTargets(layout, action).filter(
      (target) => target.locator.resourceId !== undefined
    );
    if (targets.length === 0) {
      await this.dependencies.prompt.notifyFailure(
        "No enabled element has a unique resourceId Locator in the external app"
      );
      return undefined;
    }
    const selectedId = await this.dependencies.prompt.selectTarget(
      targets.map((target) => ({
        id: target.element.id,
        label: target.label
      }))
    );
    const target = targets.find(
      (candidate) => candidate.element.id === selectedId
    );
    if (target === undefined) {
      await this.dependencies.prompt.notifyFailure(
        "Selected external element is unavailable"
      );
      return undefined;
    }

    if (action === "swipe") {
      const options = await this.dependencies.prompt.swipeOptions();
      return {
        target,
        draft: {
          action,
          locator: target.locator,
          direction: await this.dependencies.prompt.selectSwipeDirection(),
          ...options
        }
      };
    }

    if (action === "click") {
      return {
        target,
        draft: {
          action,
          locator: target.locator
        }
      };
    }

    return {
      target,
      draft: {
        action,
        locator: target.locator,
        durationMs: await this.dependencies.prompt.longClickDuration()
      }
    };
  }

  private buildExternalStep(
    draft: ActionDraft,
    expectedActivity: string
  ): ExternalStep {
    return ExternalStepSchema.parse({
      ...draft,
      expectedActivity
    });
  }

  private async pollBridgeEscape(
    identity: AppIdentity,
    input: RecordInput
  ): Promise<string | null> {
    const deadline = this.dependencies.clock.now() + 3000;
    while (this.dependencies.clock.now() < deadline) {
      if (input.signal?.aborted === true) return null;
      const foreground = await this.dependencies.adb.foregroundComponent(
        identity
      );
      if (foreground.packageName !== input.config.run.packageName) {
        return foreground.packageName;
      }
      await this.dependencies.clock.sleep(
        Math.min(
          500,
          Math.max(0, deadline - this.dependencies.clock.now())
        ),
        input.signal
      );
    }
    return null;
  }

  private async pollBridgeReturn(
    identity: AppIdentity,
    input: RecordInput,
    timeoutMs: number
  ): Promise<boolean> {
    const deadline = this.dependencies.clock.now() + timeoutMs;
    while (this.dependencies.clock.now() < deadline) {
      if (input.signal?.aborted === true) return false;
      const foreground = await this.dependencies.adb.foregroundComponent(
        identity
      );
      if (foreground.packageName === input.config.run.packageName) {
        return true;
      }
      await this.dependencies.clock.sleep(
        Math.min(
          500,
          Math.max(0, deadline - this.dependencies.clock.now())
        ),
        input.signal
      );
    }
    return false;
  }
}
