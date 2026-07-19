import { resolve } from "node:path";

import { normalizeActivity } from "../../domain/activity.js";
import type { AprConfig } from "../../domain/config.js";
import { exitCodeForFailure, type FailureCode } from "../../domain/failure.js";
import type { Journey } from "../../domain/journey.js";
import {
  hashJourney,
  type AprReport,
  type ReportFailure
} from "../../domain/report.js";
import type { AdbPort } from "../../ports/adb.js";
import type { AndroidCliPort } from "../../ports/android-cli.js";
import type { ArtifactStore } from "../../ports/artifact-store.js";
import type { Clock } from "../../ports/clock.js";
import type { GradlePort } from "../../ports/gradle.js";
import { LogcatCollector } from "../collector/logcat-collector.js";
import type { ReportWriter } from "../report/report-writer.js";
import {
  StepRunner,
  type StepRunResult,
  type StepRunnerOptions
} from "./step-runner.js";

export interface VerifyInput {
  config: AprConfig;
  journey: Journey;
  projectRoot: string;
  deviceSerial: string;
  toolVersions: Record<string, string>;
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
  gradle: GradlePort;
  androidCli: AndroidCliPort;
  adb: AdbPort;
  clock: Clock;
  artifactStore: ArtifactStore;
  reportWriter: Pick<ReportWriter, "writeAndPublish">;
  now: () => Date;
  createRunId: () => string;
  createStepRunner?: ((options: StepRunnerOptions) => StepRunnerLike) | undefined;
}

export interface VerifyResult {
  status: "passed" | "failed" | "error";
  exitCode: 0 | 1 | 2 | 3 | 4;
  report: AprReport;
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

function layerForFailure(code: FailureCode): keyof AprReport["layers"] {
  if (code === "BUILD_FAILED") {
    return "build";
  }
  if (
    code === "APP_LAUNCH_FAILED"
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
    const steps: AprReport["steps"] = [];
    const layers: AprReport["layers"] = {
      build: "notRun",
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
      const build = await this.dependencies.gradle.build({
        projectDir: input.projectRoot,
        task: input.config.build.task,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
      if (commandFailed(build)) {
        layers.build = "failed";
        setPrimary(
          "BUILD_FAILED",
          commandMessage(build, "Gradle build failed"),
          "build"
        );
      } else {
        layers.build = "passed";
      }

      let apkPath: string | undefined;
      if (primaryFailure === undefined) {
        try {
          const description = await this.dependencies.androidCli.describeProject({
            projectDir: input.projectRoot,
            target: input.config.artifact.target,
            variant: input.config.artifact.variant,
            ...(input.signal === undefined ? {} : { signal: input.signal })
          });
          apkPath = description.apkPath;
        } catch (error) {
          setPrimary("BUILD_FAILED", errorMessage(error), "describe");
        }
      }

      if (primaryFailure === undefined && apkPath !== undefined) {
        try {
          logcat.start({
            deviceSerial: input.deviceSerial,
            ...(input.signal === undefined ? {} : { signal: input.signal })
          });
          logcatStarted = true;
        } catch (error) {
          collectionFailure(errorMessage(error));
        }

        const run = await this.dependencies.androidCli.runApp({
          apkPath,
          activity: launchActivity,
          deviceSerial: input.deviceSerial,
          ...(input.signal === undefined ? {} : { signal: input.signal })
        });
        if (commandFailed(run)) {
          layers.run = "failed";
          setPrimary(
            "APP_LAUNCH_FAILED",
            commandMessage(run, "App launch failed"),
            "run"
          );
        } else {
          try {
            const identity = {
              packageName: input.config.run.packageName,
              deviceSerial: input.deviceSerial,
              ...(input.signal === undefined ? {} : { signal: input.signal })
            };
            const pid = await this.dependencies.adb.pid(identity);
            if (pid === null) {
              setPrimary(
                "APP_LAUNCH_FAILED",
                "App process was not found after launch",
                "readiness"
              );
            } else {
              if (logcatStarted) {
                logcat.scopeToPid(pid);
              }
              const activity = await this.dependencies.adb.currentActivity(identity);
              if (activity !== launchActivity) {
                setPrimary(
                  "APP_LAUNCH_FAILED",
                  `Expected launch Activity ${launchActivity}, found ${activity}`,
                  "readiness"
                );
              } else {
                await this.dependencies.androidCli.layout(input.signal);
                layers.run = "passed";
                layers.structural = "passed";
                layers.activityCheckpoint = "passed";
                layers.explicitExpect = "passed";
              }
            }
          } catch (error) {
            setPrimary("APP_LAUNCH_FAILED", errorMessage(error), "readiness");
          }
        }
      }

      if (primaryFailure === undefined) {
        const createStepRunner = this.dependencies.createStepRunner
          ?? ((options: StepRunnerOptions): StepRunnerLike => new StepRunner(options));
        const runner = createStepRunner({
          adb: this.dependencies.adb,
          androidCli: this.dependencies.androidCli,
          clock: this.dependencies.clock,
          logcat,
          artifacts: session,
          packageName: input.config.run.packageName,
          deviceSerial: input.deviceSerial,
          idle: input.config.idle
        });
        for (const [index, step] of input.journey.steps.entries()) {
          const result = await runner.run(step, index, input.signal);
          steps.push(result.report);
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
      if (primaryFailure === undefined) {
        setPrimary("INTERNAL_ERROR", errorMessage(error), "runtime");
      } else {
        secondaryErrors.push({
          code: "INTERNAL_ERROR",
          message: errorMessage(error),
          phase: "runtime"
        });
      }
    }

    const screenshotPath = "screenshot.png";
    let screenshotCollected = false;
    try {
      const screenshot = await this.dependencies.androidCli.captureScreen(
        session.path(screenshotPath),
        false,
        input.signal
      );
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
        if (commandFailed(stopped)) {
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
    const status: AprReport["status"] = failure === undefined
      ? "passed"
      : failure.code === "INTERNAL_ERROR"
        ? "error"
        : "failed";
    const report: AprReport = {
      schemaVersion: 1,
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
        tools: input.toolVersions
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
