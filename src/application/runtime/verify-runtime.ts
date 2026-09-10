import { resolve } from "node:path";

import { normalizeActivity } from "../../domain/activity.js";
import type { TapHoundConfig } from "../../domain/config.js";
import {
  exitCodeForFailure,
  failureCodeFromUnknown,
  type FailureCode
} from "../../domain/failure.js";
import {
  DEFAULT_DEVICE_ROLE,
  type Journey,
  type JourneyStep
} from "../../domain/journey.js";
import {
  hashJourney,
  type TapHoundReport,
  type ReportFailure
} from "../../domain/report.js";
import type { ArtifactStore } from "../../ports/artifact-store.js";
import type { Clock } from "../../ports/clock.js";
import type {
  RuntimeSession,
  RuntimeSessionOpener
} from "../../ports/runtime-backend.js";
import type {
  RuntimeSessionPortViews,
  RuntimeSessionPortViewsFactory
} from "../../ports/runtime-session-ports.js";
import type { AnchorResolverPort } from "../../ports/anchor-resolver.js";
import type { UiSnapshotProvider } from "../../ports/ui-snapshot.js";
import type { DeviceAssignment } from "../devices/resolve-device-assignments.js";
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

export type VerifyProgressEvent =
  | { stage: "preparing" }
  | { stage: "replaying"; stepIndex: number; stepCount: number }
  | { stage: "collecting" };

export interface VerifyInput {
  config: TapHoundConfig;
  journey: Journey;
  projectRoot: string;
  devices: DeviceAssignment[];
  toolVersions: Record<string, string>;
  requireFocusedInput?: boolean | undefined;
  generatedReplayPolicy?: boolean | undefined;
  manualReplay?: boolean | undefined;
  signal?: AbortSignal | undefined;
  progress?: ((event: VerifyProgressEvent) => void) | undefined;
}

export interface StepRunnerLike {
  run: (
    step: Journey["steps"][number],
    index: number,
    signal?: AbortSignal
  ) => Promise<StepRunResult>;
}

export interface VerifyRuntimeDependencies {
  sessions: RuntimeSessionOpener;
  sessionPorts: RuntimeSessionPortViewsFactory;
  clock: Clock;
  artifactStore: ArtifactStore;
  reportWriter: Pick<ReportWriter, "writeAndPublish">;
  now: () => Date;
  createRunId: () => string;
  createStepRunner?: ((options: StepRunnerOptions) => StepRunnerLike) | undefined;
  anchorResolverFor?: ((projectRoot: string) => AnchorResolverPort) | undefined;
}

export interface VerifyResult {
  status: "passed" | "failed" | "error" | "manualRequired";
  exitCode: 0 | 1 | 2 | 3 | 4;
  report: TapHoundReport;
  reportPath: string;
  summaryPath: string;
}

interface DeviceRuntime {
  role: string;
  deviceSerial: string;
  session: RuntimeSession;
  views: RuntimeSessionPortViews;
  provider: UiSnapshotProvider | undefined;
  logcat: LogcatCollector;
  logcatStarted: boolean;
  runner: StepRunnerLike | undefined;
}

interface DeviceCoverageFailure {
  code: Extract<FailureCode, "CONFIG_INVALID" | "DEVICE_ROLE_UNMAPPED">;
  message: string;
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
    || code === "RUNTIME_CAPABILITY_MISSING"
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

function soleRoleForJourney(journey: Journey): string {
  return journey.devices[0]?.role ?? DEFAULT_DEVICE_ROLE;
}

function stepDeviceRole(step: JourneyStep, soleRole: string): string {
  return step.device ?? soleRole;
}

function deviceCoverageFailure(
  journey: Journey,
  devices: readonly DeviceAssignment[]
): DeviceCoverageFailure | undefined {
  const duplicateRole = devices.find((assignment, index) => devices.some(
    (other, otherIndex) => otherIndex > index && other.role === assignment.role
  ));
  if (duplicateRole !== undefined) {
    return {
      code: "CONFIG_INVALID",
      message: `Duplicate device assignment for role: ${duplicateRole.role}`
    };
  }

  const reusedSerial = devices.find((assignment, index) => devices.some(
    (other, otherIndex) => otherIndex > index
      && other.deviceSerial === assignment.deviceSerial
  ));
  if (reusedSerial !== undefined) {
    return {
      code: "CONFIG_INVALID",
      message: `Device serial is mapped to multiple roles: ${reusedSerial.deviceSerial}`
    };
  }

  const declaredRoles = journey.devices.map((device) => device.role);
  const unknownRole = devices.find(
    (assignment) => !declaredRoles.includes(assignment.role)
  );
  if (unknownRole !== undefined) {
    return {
      code: "CONFIG_INVALID",
      message: `Device assignment references a role the Journey does not declare: ${unknownRole.role}`
    };
  }

  const assignedRoles = new Set(devices.map((assignment) => assignment.role));
  const missingRoles = declaredRoles.filter((role) => !assignedRoles.has(role));
  if (missingRoles.length > 0) {
    return {
      code: "DEVICE_ROLE_UNMAPPED",
      message: `No device mapping for journey role(s): ${missingRoles.join(", ")}`
    };
  }

  return undefined;
}

function uniqueAssignmentsByRole(
  devices: readonly DeviceAssignment[]
): DeviceAssignment[] {
  const seen = new Set<string>();
  const unique: DeviceAssignment[] = [];
  for (const assignment of devices) {
    if (seen.has(assignment.role)) {
      continue;
    }
    seen.add(assignment.role);
    unique.push(assignment);
  }
  return unique;
}

export class VerifyRuntime {
  public constructor(private readonly dependencies: VerifyRuntimeDependencies) {}

  public async verify(input: VerifyInput): Promise<VerifyResult> {
    if (input.devices.length === 0) {
      throw new Error("VerifyInput.devices requires at least one device assignment");
    }
    input.progress?.({ stage: "preparing" });
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
    const coverage = deviceCoverageFailure(input.journey, input.devices);
    const assignmentByRole = new Map(
      input.devices.map((assignment) => [assignment.role, assignment])
    );
    const runtimes: DeviceRuntime[] = [];
    let primaryFailure: ReportFailure | undefined = coverage === undefined
      ? undefined
      : {
          code: coverage.code,
          message: coverage.message,
          phase: "runtime"
        };
    const secondaryErrors: ReportFailure[] = [];
    const collectionErrors: ReportFailure[] = [];
    const steps: TapHoundReport["steps"] = [];
    const layers: TapHoundReport["layers"] = {
      run: "notRun",
      structural: "notRun",
      activityCheckpoint: "notRun",
      explicitExpect: "notRun",
      collection: "passed"
    };
    if (coverage !== undefined) {
      layers[layerForFailure(coverage.code)] = "failed";
    }

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
      const createStepRunner = this.dependencies.createStepRunner
        ?? ((options: StepRunnerOptions): StepRunnerLike => new StepRunner(options));
      if (coverage === undefined) {
        for (const declaration of input.journey.devices) {
          const assignment = assignmentByRole.get(declaration.role);
          if (assignment === undefined) {
            continue;
          }
          const deviceSession = await this.dependencies.sessions.openSession({
            deviceSerial: assignment.deviceSerial,
            ...(input.signal === undefined ? {} : { signal: input.signal })
          });
          const views = this.dependencies.sessionPorts(deviceSession);
          runtimes.push({
            role: declaration.role,
            deviceSerial: assignment.deviceSerial,
            session: deviceSession,
            views,
            provider: undefined,
            logcat: new LogcatCollector(views.adb, this.dependencies.clock),
            logcatStarted: false,
            runner: undefined
          });
        }
      }
      for (const runtime of runtimes) {
        if (primaryFailure !== undefined) {
          break;
        }
        const deviceSession = runtime.session;
        const provider = await deviceSession.openUiSnapshots({
          timeoutMs: input.config.ui?.snapshotTimeoutMs
            ?? input.config.idle.timeoutMs,
          backend: input.config.ui?.backend ?? "auto",
          cacheEnabled: input.config.ui?.cacheEnabled ?? true,
          ...(input.signal === undefined ? {} : { signal: input.signal })
        });
        runtime.provider = provider;

        let installFailed = false;
        try {
          const installed = await deviceSession.isInstalled({
            packageName: input.config.run.packageName,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            timeoutMs: input.config.idle.timeoutMs
          });
          if (!installed) {
            setPrimary(
              "APP_NOT_INSTALLED",
              `Package ${input.config.run.packageName} is not installed on ${runtime.deviceSerial}`,
              "install"
            );
            installFailed = true;
          }
        } catch (error) {
          setPrimary("APP_NOT_INSTALLED", errorMessage(error), "install");
          installFailed = true;
        }
        if (installFailed) {
          break;
        }

        try {
          await runtime.logcat.start({
            deviceSerial: runtime.deviceSerial,
            ...(input.signal === undefined ? {} : { signal: input.signal })
          });
          runtime.logcatStarted = true;
        } catch (error) {
          layers.collection = "failed";
          setPrimary(
            failureCodeFromUnknown(error) ?? "COLLECTION_FAILED",
            errorMessage(error),
            "collection"
          );
        }
        if (!runtime.logcatStarted) {
          break;
        }

        const app = {
          packageName: input.config.run.packageName,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          timeoutMs: input.config.idle.timeoutMs
        };
        const stopped = await deviceSession.forceStop(app);
        const launched = commandFailed(stopped)
          ? undefined
          : await deviceSession.launchApp({
              packageName: input.config.run.packageName,
              activity: launchActivity,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
              timeoutMs: input.config.idle.timeoutMs
            });
        const launchError = launched === undefined
          ? commandMessage(stopped, "App reset failed")
          : launchFailure(launched);
        if (launchError !== undefined) {
          layers.run = "failed";
          setPrimary("APP_LAUNCH_FAILED", launchError, "run");
          break;
        }

        try {
          const launchReadinessStartedAt = this.dependencies.clock.now();
          const processReadiness = await new ProcessWaiter(
            runtime.views.adb,
            this.dependencies.clock
          ).wait({
            packageName: input.config.run.packageName,
            deviceSerial: runtime.deviceSerial,
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
            break;
          }
          if (processReadiness.status === "cancelled") {
            setPrimary(
              "INTERNAL_ERROR",
              "Verification was cancelled",
              "readiness"
            );
            break;
          }
          runtime.logcat.scopeToPids(processReadiness.pids);
          const soleRole = soleRoleForJourney(input.journey);
          const firstOwnStep = input.journey.steps.find(
            (step) => stepDeviceRole(step, soleRole) === runtime.role
          );
          if (firstOwnStep === undefined) {
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
              `Expected startup Activity ${firstOwnStep.activity.before}, found none before timeout`,
              "readiness"
            );
            break;
          }
          const readiness = await new ActivityWaiter(
            runtime.views.adb,
            this.dependencies.clock
          ).wait({
            packageName: input.config.run.packageName,
            deviceSerial: runtime.deviceSerial,
            expectedActivity: firstOwnStep.activity.before,
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
            break;
          }
          if (readiness.status === "timeout") {
            setPrimary(
              "APP_LAUNCH_FAILED",
              `Expected startup Activity ${firstOwnStep.activity.before}, found ${readiness.actual ?? "none"} before timeout`,
              "readiness"
            );
            break;
          }
          if (readiness.status === "cancelled") {
            setPrimary(
              "INTERNAL_ERROR",
              "Verification was cancelled",
              "readiness"
            );
            break;
          }
          await provider.capture({
            reason: "locate",
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            timeoutMs: input.config.idle.timeoutMs
          });
          runtime.runner = createStepRunner({
            adb: runtime.views.adb,
            screenshots: runtime.views.screenshots,
            annotatedScreens: runtime.views.annotatedScreens,
            uiStability: runtime.views.uiStability,
            uiSnapshotProvider: provider,
            clock: this.dependencies.clock,
            logcat: runtime.logcat,
            artifacts: session,
            packageName: input.config.run.packageName,
            deviceSerial: runtime.deviceSerial,
            deviceRole: runtime.role,
            idle: input.config.idle,
            ...(this.dependencies.anchorResolverFor === undefined
              ? {}
              : { anchorResolver: this.dependencies.anchorResolverFor(input.projectRoot) }),
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
        } catch (error) {
          setPrimary(
            failureCodeFromUnknown(error) ?? "APP_LAUNCH_FAILED",
            errorMessage(error),
            "readiness"
          );
          break;
        }
      }

      if (primaryFailure === undefined) {
        layers.run = "passed";
        layers.structural = "passed";
        layers.activityCheckpoint = "passed";
        layers.explicitExpect = "passed";
      }

      if (primaryFailure === undefined) {
        const soleRole = soleRoleForJourney(input.journey);
        const runtimeByRole = new Map(
          runtimes.map((runtime) => [runtime.role, runtime])
        );
        for (const [index, step] of input.journey.steps.entries()) {
          input.progress?.({
            stage: "replaying",
            stepIndex: index,
            stepCount: input.journey.steps.length
          });
          const role = stepDeviceRole(step, soleRole);
          const runner = runtimeByRole.get(role)?.runner;
          if (runner === undefined) {
            setPrimary(
              "CONFIG_INVALID",
              `Step references an unmapped device role: ${role}`,
              "replay",
              index
            );
            break;
          }
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
      for (const runtime of runtimes) {
        if (runtime.provider === undefined) {
          continue;
        }
        try {
          await runtime.provider.close();
        } catch (error) {
          secondaryErrors.push({
            code: "INTERNAL_ERROR",
            message: errorMessage(error),
            phase: "uiSnapshotClose"
          });
        }
      }
    }

    const screenshotEntries: TapHoundReport["artifacts"]["screenshots"] = [];
    const logcatEntries: TapHoundReport["artifacts"]["logcats"] = [];
    input.progress?.({ stage: "collecting" });
    if (coverage === undefined) {
      for (const runtime of runtimes) {
        const screenshotPath = `screenshot-${runtime.role}.png`;
        try {
          const screenshot = await runtime.session.captureScreenshot({
            outputPath: session.path(screenshotPath),
            ...(input.signal === undefined ? {} : { signal: input.signal })
          });
          if (commandFailed(screenshot)) {
            collectionFailure(commandMessage(screenshot, "Screen capture failed"));
          } else {
            screenshotEntries.push({ role: runtime.role, path: screenshotPath });
          }
        } catch (error) {
          collectionFailure(errorMessage(error));
        }

        if (runtime.logcatStarted) {
          const logcatPath = `logcat-${runtime.role}.txt`;
          try {
            const stopped = await runtime.logcat.stop();
            if (logcatStopFailed(stopped)) {
              collectionFailure(commandMessage(stopped, "Logcat stop failed"));
            }
            await session.writeText(
              logcatPath,
              runtime.logcat.lines().map((line) => line.raw).join("\n")
            );
            logcatEntries.push({ role: runtime.role, path: logcatPath });
          } catch (error) {
            collectionFailure(errorMessage(error));
          }
        }
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
            "DEVICE_ROLE_UNMAPPED",
            "APP_NOT_INSTALLED",
            "INTERNAL_ERROR"
          ].includes(failure.code)
        ? "error"
        : "failed";
    const report: TapHoundReport = {
      schemaVersion: 4,
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
        devices: coverage === undefined
          ? runtimes.map((runtime) => ({
              role: runtime.role,
              deviceSerial: runtime.deviceSerial,
              ...(runtime.provider === undefined
                ? {}
                : {
                    uiBackend: runtime.provider.descriptor,
                    ...(runtime.provider.cacheTelemetry === undefined
                      ? {}
                      : { uiCache: runtime.provider.cacheTelemetry() })
                  })
            }))
          : uniqueAssignmentsByRole(input.devices).map((assignment) => ({
              role: assignment.role,
              deviceSerial: assignment.deviceSerial
            })),
        tools: input.toolVersions
      },
      layers,
      steps,
      artifacts: {
        directory: session.finalDirectory,
        report: "report.json",
        summary: "summary.txt",
        screenshots: screenshotEntries,
        logcats: logcatEntries,
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
