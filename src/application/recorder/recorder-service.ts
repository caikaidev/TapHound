import { parse } from "node:path";

import { normalizeActivity } from "../../domain/activity.js";
import type { TapHoundConfig } from "../../domain/config.js";
import {
  JourneySchema,
  JourneyStepSchema,
  type Journey,
  type JourneyStep
} from "../../domain/journey.js";
import type { LayoutElement, Locator } from "../../domain/layout.js";
import type { AdbPort } from "../../ports/adb.js";
import type { AndroidCliPort } from "../../ports/android-cli.js";
import type { Clock } from "../../ports/clock.js";
import type { GradlePort } from "../../ports/gradle.js";
import type { JourneyWriterPort } from "../../ports/journey-writer.js";
import type {
  RecorderAction,
  RecorderPromptPort
} from "../../ports/recorder-prompt.js";
import { ActionExecutor, type ActionTarget } from "../interaction/action-executor.js";
import { IdleWaiter } from "../wait/idle-waiter.js";
import { listRecorderTargets, type RecorderTarget } from "./locator-selector.js";

export interface RecorderDependencies {
  gradle: GradlePort;
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
  | { action: "wait" };

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
    const build = await this.dependencies.gradle.build({
      projectDir: input.projectRoot,
      task: input.config.build.task,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    if (failedCommand(build)) {
      return {
        status: "failed",
        stepsRecorded: 0,
        message: commandMessage(build, "Gradle build failed")
      };
    }
    const description = await this.dependencies.androidCli.describeProject({
      projectDir: input.projectRoot,
      target: input.config.artifact.target,
      variant: input.config.artifact.variant,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    const run = await this.dependencies.androidCli.runApp({
      apkPath: description.apkPath,
      activity: launchActivity,
      deviceSerial: input.deviceSerial,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    if (failedCommand(run)) {
      return {
        status: "failed",
        stepsRecorded: 0,
        message: commandMessage(run, "App launch failed")
      };
    }

    const identity = {
      packageName: input.config.run.packageName,
      deviceSerial: input.deviceSerial,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeoutMs: input.config.idle.timeoutMs
    };
    const pid = await this.dependencies.adb.pid(identity);
    const initialActivity = await this.dependencies.adb.currentActivity(identity);
    if (pid === null || normalizeActivity(input.config.run.packageName, initialActivity) !== launchActivity) {
      return {
        status: "failed",
        stepsRecorded: 0,
        message: "App did not reach the configured launch Activity"
      };
    }
    await this.dependencies.androidCli.layout({
      deviceSerial: input.deviceSerial,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeoutMs: input.config.idle.timeoutMs
    });

    const steps: JourneyStep[] = [];
    const executor = new ActionExecutor(
      this.dependencies.adb,
      input.deviceSerial
    );
    const idleWaiter = new IdleWaiter(
      this.dependencies.androidCli,
      this.dependencies.clock,
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

      const prepared = await this.prepareAction(action, layout, input);
      if (prepared === undefined) {
        continue;
      }
      const before = normalizeActivity(
        input.config.run.packageName,
        await this.dependencies.adb.currentActivity(identity)
      );
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
      if (await this.dependencies.adb.pid(identity) === null) {
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
    action: Exclude<RecorderAction, "finish" | "cancel">,
    layout: readonly LayoutElement[],
    input: RecordInput
  ): Promise<{ draft: ActionDraft; target?: RecorderTarget } | undefined> {
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
}
