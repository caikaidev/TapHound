import { resolve } from "node:path";

import { normalizeActivity } from "../../domain/activity.js";
import type { TapHoundConfig } from "../../domain/config.js";
import {
  exitCodeForFailure,
  failureCodeFromUnknown,
  type FailureCode
} from "../../domain/failure.js";
import type { Journey } from "../../domain/journey.js";
import {
  hashJourney,
  type TapHoundReport,
  type ReportFailure
} from "../../domain/report.js";
import type { AdbPort } from "../../ports/adb.js";
import type {
  AnnotatedScreenResolverPort
} from "../../ports/annotated-screen-resolver.js";
import type { ArtifactStore } from "../../ports/artifact-store.js";
import type { Clock } from "../../ports/clock.js";
import type { ScreenshotPort } from "../../ports/screenshot.js";
import type { UiStabilityProbe } from "../../ports/ui-stability.js";
import type {
  UiSnapshotProvider,
  UiSnapshotProviderFactory
} from "../../ports/ui-snapshot.js";
import { LogcatCollector } from "../collector/logcat-collector.js";
import { logcatStopFailed } from "../collector/logcat-stop.js";
import type { ReportWriter } from "../report/report-writer.js";
import { ActivityWaiter } from "./activity-waiter.js";
import { launchFailure } from "./launch-failure.js";
import { ProcessWaiter } from "./process-waiter.js";
import {
  StepRunner,
  type StepRunResult,
  type StepRunnerOptions
} from "./step-runner.js";

export interface VerifyInput {
  config: TapHoundConfig;
  journey: Journey;
  projectRoot: string;
  deviceSerial: string;
  toolVersions: Record<string, string>;
  requireFocusedInput?: boolean | undefined;
  generatedReplayPolicy?: boolean | undefined;
  manualReplay?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface StepRunnerLike {
  run: (
    step: Journey["steps"][number],
    index: number,
    signal?: AbortSignal
  ) => Promise<StepRunResult>;
}

export interface VerifyRuntimeDependencies {
  screenshots: ScreenshotPort;
  annotatedScreens: AnnotatedScreenResolverPort;
  uiStability: UiStabilityProbe;
  uiSnapshots: UiSnapshotProviderFactory;
  adb: AdbPort;
  clock: Clock;
  artifactStore: ArtifactStore;
  reportWriter: Pick<ReportWriter, "writeAndPublish">;
  now: () => Date;
  createRunId: () => string;
  createStepRunner?: ((options: StepRunnerOptions) => StepRunnerLike) | undefined;
}

export interface VerifyResult {
  status: "passed" | "failed" | "error" | "manualRequired";
  exitCode: 0 | 1 | 2 | 3 | 4;
  report: TapHoundReport;
  reportPath: string;
  summaryPath: string;
}

function commandFailed(result: {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function layerForFailure(code: FailureCode): keyof TapHoundReport["layers"] {
  if (
    code === "APP_NOT_INSTALLED"
    || code === "APP_LAUNCH_FAILED"
    || code === "APP_CRASHED"
  ) {
    return "run";
  }
  if (
    code === "ACTIVITY_BEFORE_MISMATCH"
    || code === "ACTIVITY_AFTER_MISMATCH"
  ) {
    return "activityCheckpoint";
  }
  if (code.startsWith("EXPECT_")) {
    return "explicitExpect";
  }
  if (code === "COLLECTION_FAILED") {
    return "collection";
  }
  return "structural";
}

export class VerifyRuntime {
  public constructor(private readonly dependencies: VerifyRuntimeDependencies) {}

  public async verify(input: VerifyInput): Promise<VerifyResult> {
    const startedAt = this.dependencies.now();
    const runId = this.dependencies.createRunId();
    const launchActivity = normalizeActivity(
      input.config.run.packageName,
      input.config.run.activity
    );
    const session = await this.dependencies.artifactStore.begin(
      resolve(input.projectRoot, input.config.artifactsDir),
      runId
    );
    const logcat = new LogcatCollector(
      this.dependencies.adb,
      this.dependencies.clock
    );
    let logcatStarted = false;
    let primaryFailure: ReportFailure | undefined;
    const secondaryErrors: ReportFailure[] = [];
    const collectionErrors: ReportFailure[] = [];
    let uiSnapshotProvider: UiSnapshotProvider | undefined;
    const steps: TapHoundReport["steps"] = [];
    const layers: TapHoundReport["layers"] = {
      run: "notRun",
      structural: "notRun",
      activityCheckpoint: "notRun",
      explicitExpect: "notRun",
      collection: "passed"
    };

    const setPrimary = (
      code: FailureCode,
      message: string,
      phase: string,
      stepIndex?: number
    ): void => {
      if (primaryFailure !== undefined) {
        return;
      }
      primaryFailure = {
        code,
        message,
        phase,
        ...(stepIndex === undefined ? {} : { stepIndex })
      };
      layers[layerForFailure(code)] = "failed";
    };
    const collectionFailure = (message: string): void => {
      layers.collection = "failed";
      const failure: ReportFailure = {
        code: "COLLECTION_FAILED",
        message,
        phase: "collection"
      };
      collectionErrors.push(failure);
    };

    try {
      uiSnapshotProvider = await this.dependencies.uiSnapshots.open({
        deviceSerial: input.deviceSerial,
        timeoutMs: input.config.ui?.snapshotTimeoutMs
          ?? input.config.idle.timeoutMs,
        backend: input.config.ui?.backend ?? "auto",
        cacheEnabled: input.config.ui?.cacheEnabled ?? true,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
      try {
        const installed = await this.dependencies.adb.isInstalled({
          packageName: input.config.run.packageName,
          deviceSerial: input.deviceSerial,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          timeoutMs: input.config.idle.timeoutMs
        });
        if (!installed) {
          setPrimary(
            "APP_NOT_INSTALLED",
            `Package ${input.config.run.packageName} is not installed on ${input.deviceSerial}`,
            "install"
          );
        }
      } catch (error) {
        setPrimary("APP_NOT_INSTALLED", errorMessage(error), "install");
      }

      if (primaryFailure === undefined) {
        try {
          await logcat.start({
            deviceSerial: input.deviceSerial,
            ...(input.signal === undefined ? {} : { signal: input.signal })
          });
          logcatStarted = true;
        } catch (error) {
          layers.collection = "failed";
          setPrimary(
            "COLLECTION_FAILED",
            errorMessage(error),
            "collection"
          );
        }

        if (logcatStarted) {
          const identity = {
            packageName: input.config.run.packageName,
            deviceSerial: input.deviceSerial,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            timeoutMs: input.config.idle.timeoutMs
          };
          const stopped = await this.dependencies.adb.forceStop(identity);
          const launched = commandFailed(stopped)
            ? undefined
            : await this.dependencies.adb.launchActivity({
                packageName: input.config.run.packageName,
                activity: launchActivity,
                deviceSerial: input.deviceSerial,
                ...(input.signal === undefined ? {} : { signal: input.signal }),
                timeoutMs: input.config.idle.timeoutMs
              });
          const launchError = launched === undefined
            ? commandMessage(stopped, "App reset failed")
            : launchFailure(launched);
          if (launchError !== undefined) {
            layers.run = "failed";
            setPrimary("APP_LAUNCH_FAILED", launchError, "run");
          } else {
            try {
              const launchReadinessStartedAt = this.dependencies.clock.now();
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
              if (processReadiness.status === "timeout") {
                setPrimary(
                  "APP_LAUNCH_FAILED",
                  "App process was not found after launch",
                  "readiness"
                );
              } else if (processReadiness.status === "cancelled") {
                setPrimary(
                  "INTERNAL_ERROR",
                  "Verification was cancelled",
                  "readiness"
                );
              } else {
                logcat.scopeToPids(processReadiness.pids);
                const firstStep = input.journey.steps[0];
                if (firstStep === undefined) {
                  throw new Error("Journey requires at least one step");
                }
                const remainingReadinessMs = input.config.idle.timeoutMs
                  - (
                    this.dependencies.clock.now()
                    - launchReadinessStartedAt
                  );
                if (remainingReadinessMs <= 0) {
                  setPrimary(
                    "APP_LAUNCH_FAILED",
                    `Expected startup Activity ${firstStep.activity.before}, found none before timeout`,
                    "readiness"
                  );
                } else {
                  const readiness = await new ActivityWaiter(
                    this.dependencies.adb,
                    this.dependencies.clock
                  ).wait({
                    packageName: input.config.run.packageName,
                    deviceSerial: input.deviceSerial,
                    expectedActivity: firstStep.activity.before,
                    pollIntervalMs: input.config.idle.pollIntervalMs,
                    timeoutMs: remainingReadinessMs,
                    ...(input.signal === undefined ? {} : { signal: input.signal })
                  });

                  if (readiness.status === "processMissing") {
                    setPrimary(
                      "APP_LAUNCH_FAILED",
                      "App process exited before reaching the first Journey Activity",
                      "readiness"
                    );
                  } else if (readiness.status === "timeout") {
                    setPrimary(
                      "APP_LAUNCH_FAILED",
                      `Expected startup Activity ${firstStep.activity.before}, found ${readiness.actual ?? "none"} before timeout`,
                      "readiness"
                    );
                  } else if (readiness.status === "cancelled") {
                    setPrimary(
                      "INTERNAL_ERROR",
                      "Verification was cancelled",
                      "readiness"
                    );
                  } else {
                    await uiSnapshotProvider.capture({
                      reason: "locate",
                      ...(input.signal === undefined ? {} : { signal: input.signal }),
                      timeoutMs: input.config.idle.timeoutMs
                    });
                    layers.run = "passed";
                    layers.structural = "passed";
                    layers.activityCheckpoint = "passed";
                    layers.explicitExpect = "passed";
                  }
                }
              }
            } catch (error) {
              setPrimary(
                failureCodeFromUnknown(error) ?? "APP_LAUNCH_FAILED",
                errorMessage(error),
                "readiness"
              );
            }
          }
        }
      }

      if (primaryFailure === undefined) {
        const createStepRunner = this.dependencies.createStepRunner
          ?? ((options: StepRunnerOptions): StepRunnerLike => new StepRunner(options));
        const runner = createStepRunner({
          adb: this.dependencies.adb,
          screenshots: this.dependencies.screenshots,
          annotatedScreens: this.dependencies.annotatedScreens,
          uiStability: this.dependencies.uiStability,
          uiSnapshotProvider,
          clock: this.dependencies.clock,
          logcat,
          artifacts: session,
          packageName: input.config.run.packageName,
          deviceSerial: input.deviceSerial,
          idle: input.config.idle,
          ...(input.requireFocusedInput === undefined
            ? {}
            : { requireFocusedInput: input.requireFocusedInput }),
          ...(input.generatedReplayPolicy === undefined
            ? {}
            : { generatedReplayPolicy: input.generatedReplayPolicy }),
          ...(input.manualReplay === undefined
            ? {}
            : { manualReplay: input.manualReplay })
        });
        for (const [index, step] of input.journey.steps.entries()) {
          const result = await runner.run(step, index, input.signal);
          steps.push(result.report);
          if (result.status === "manualRequired") {
            setPrimary(
              "MANUAL_STEP_REQUIRED",
              `Step ${String(index)} requires manual replay and the run is non-interactive`,
              "replay",
              index
            );
            break;
          }
          if (result.status === "cancelled") {
            setPrimary(
              "INTERNAL_ERROR",
              "Verification was cancelled",
              "replay",
              index
            );
            break;
          }
          if (result.status === "failed") {
            setPrimary(
              result.failure.code,
              result.failure.message,
              result.failure.phase,
              result.failure.stepIndex
            );
            break;
          }
        }
      }
    } catch (error) {
      const errorCode = failureCodeFromUnknown(error) ?? "INTERNAL_ERROR";
      if (primaryFailure === undefined) {
        setPrimary(errorCode, errorMessage(error), "runtime");
      } else {
        secondaryErrors.push({
          code: errorCode,
          message: errorMessage(error),
          phase: "runtime"
        });
      }
    } finally {
      if (uiSnapshotProvider !== undefined) {
        try {
          await uiSnapshotProvider.close();
        } catch (error) {
          secondaryErrors.push({
            code: "INTERNAL_ERROR",
            message: errorMessage(error),
            phase: "uiSnapshotClose"
          });
        }
      }
    }

    const screenshotPath = "screenshot.png";
    let screenshotCollected = false;
    try {
      const screenshot = await this.dependencies.screenshots.capture({
        outputPath: session.path(screenshotPath),
        deviceSerial: input.deviceSerial,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
      if (commandFailed(screenshot)) {
        collectionFailure(commandMessage(screenshot, "Screen capture failed"));
      } else {
        screenshotCollected = true;
      }
    } catch (error) {
      collectionFailure(errorMessage(error));
    }

    let logcatCollected = false;
    if (logcatStarted) {
      try {
        const stopped = await logcat.stop();
        if (logcatStopFailed(stopped)) {
          collectionFailure(commandMessage(stopped, "Logcat stop failed"));
        }
        await session.writeText(
          "logcat.txt",
          logcat.lines().map((line) => line.raw).join("\n")
        );
        logcatCollected = true;
      } catch (error) {
        collectionFailure(errorMessage(error));
      }
    }

    if (collectionErrors.length > 0) {
      if (primaryFailure === undefined) {
        primaryFailure = collectionErrors.shift();
      }
      secondaryErrors.push(...collectionErrors);
    }

    const finishedAt = this.dependencies.now();
    const failure = primaryFailure;
    const status: TapHoundReport["status"] = failure === undefined
      ? "passed"
      : failure.code === "MANUAL_STEP_REQUIRED"
        ? "manualRequired"
        : [
            "CONFIG_INVALID",
            "ENVIRONMENT_MISSING_TOOL",
            "DEVICE_UNAVAILABLE",
            "APP_NOT_INSTALLED",
            "INTERNAL_ERROR"
          ].includes(failure.code)
        ? "error"
        : "failed";
    const report: TapHoundReport = {
      schemaVersion: 3,
      runId,
      status,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      project: {
        root: input.projectRoot,
        packageName: input.config.run.packageName,
        launchActivity
      },
      journey: {
        name: input.journey.name,
        sha256: hashJourney(input.journey)
      },
      environment: {
        deviceSerial: input.deviceSerial,
        tools: input.toolVersions,
        ...(uiSnapshotProvider === undefined
          ? {}
          : {
              uiBackend: uiSnapshotProvider.descriptor,
              ...(uiSnapshotProvider.cacheTelemetry === undefined
                ? {}
                : { uiCache: uiSnapshotProvider.cacheTelemetry() })
            })
      },
      layers,
      steps,
      artifacts: {
        directory: session.finalDirectory,
        report: "report.json",
        summary: "summary.txt",
        ...(screenshotCollected ? { screenshot: screenshotPath } : {}),
        ...(logcatCollected ? { logcat: "logcat.txt" } : {}),
        stepLogs: steps.flatMap((step) => (
          step.logcatPath === undefined ? [] : [step.logcatPath]
        ))
      },
      ...(failure === undefined ? {} : { primaryFailure: failure }),
      secondaryErrors,
      fallbackUsed: steps.some(
        (step) => step.locator?.fallbackUsed === true
      )
    };
    const published = await this.dependencies.reportWriter.writeAndPublish(
      session,
      report
    );
    return {
      status,
      exitCode: failure === undefined ? 0 : exitCodeForFailure(failure.code),
      report,
      reportPath: published.reportPath,
      summaryPath: published.summaryPath
    };
  }
}
