import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AdbAdapter } from "../adapters/adb/adb-adapter.js";
import { AndroidCliAdapter } from "../adapters/android-cli/android-cli-adapter.js";
import { SystemClock } from "../adapters/clock/system-clock.js";
import { FileSystemArtifactStore } from "../adapters/filesystem/artifact-store.js";
import { FileSystemGenerationMetaWriter } from "../adapters/filesystem/generation-meta-writer.js";
import { FileSystemGenerationSessionStore } from "../adapters/filesystem/generation-session-store.js";
import { FileSystemJourneyWriter } from "../adapters/filesystem/journey-writer.js";
import { NodeProjectFileInspector } from "../adapters/filesystem/project-file-inspector.js";
import { GradleAdapter } from "../adapters/gradle/gradle-adapter.js";
import { NodeProcessRunner } from "../adapters/process/node-process-runner.js";
import { InquirerRecorderPrompt } from "../adapters/prompt/inquirer-recorder-prompt.js";
import { InquirerGenerationPrompt } from "../adapters/prompt/inquirer-generation-prompt.js";
import { ContextValidator } from "../application/context/context-validator.js";
import { DoctorService } from "../application/doctor/doctor-service.js";
import type { DoctorReport } from "../application/doctor/doctor-service.js";
import {
  GenerationConfirmationService
} from "../application/generation/generation-confirmation-service.js";
import {
  GenerationFinalizer
} from "../application/generation/generation-finalizer.js";
import {
  GenerationPublisher
} from "../application/generation/generation-publisher.js";
import {
  GenerationStarter,
  type GenerationStartInput
} from "../application/generation/generation-starter.js";
import {
  GenerationStepExecutor
} from "../application/generation/generation-step-executor.js";
import {
  RuntimeObserver,
  SnapshotReobservationGuard,
  type RuntimeObservation,
  type RuntimeObserveInput
} from "../application/generation/runtime-observer.js";
import { ProjectDescriber } from "../application/project/project-describer.js";
import { RecorderService, type RecordInput, type RecordResult } from "../application/recorder/recorder-service.js";
import { ReportWriter } from "../application/report/report-writer.js";
import { VerifyRuntime, type VerifyInput, type VerifyResult } from "../application/runtime/verify-runtime.js";
import type { TapHoundConfig } from "../domain/config.js";
import type { GenerationSession } from "../domain/generation.js";
import type {
  GenerationSessionStore
} from "../ports/generation-session-store.js";

export interface TextOutput {
  write: (content: string) => void;
}

export interface GenerationCliRuntime {
  confirmation: Pick<
    GenerationConfirmationService,
    "request" | "requestManual" | "confirmStored" | "findPendingManual"
  >;
  executor: Pick<GenerationStepExecutor, "execute">;
  observer: Pick<RuntimeObserver, "observe">;
  finalizer: Pick<GenerationFinalizer, "finalize">;
  readSession: (id: string) => Promise<GenerationSession>;
}

export interface CliDependencies {
  signal?: AbortSignal | undefined;
  doctor: {
    run: (
      projectRoot: string,
      signal?: AbortSignal,
      requestedDevice?: string
    ) => Promise<DoctorReport>;
  };
  recorder: {
    record: (input: RecordInput) => Promise<RecordResult>;
  };
  verifier: {
    verify: (input: VerifyInput) => Promise<VerifyResult>;
  };
  projectDescriber: Pick<ProjectDescriber, "describe">;
  contextValidator: Pick<ContextValidator, "validate">;
  generationStarter: {
    start: (input: GenerationStartInput) => Promise<
      Awaited<ReturnType<GenerationStarter["start"]>>
    >;
  };
  runtimeObserver: {
    observe: (
      input: RuntimeObserveInput & { projectRoot: string }
    ) => Promise<RuntimeObservation>;
  };
  generationRuntime?: (input: {
    projectRoot: string;
    config: TapHoundConfig;
  }) => GenerationCliRuntime;
  readJson: (path: string) => Promise<unknown>;
  cwd: () => string;
  stdout: TextOutput;
  stderr: TextOutput;
  setExitCode: (code: number) => void;
}

export interface ProductionDependencyOptions {
  generationStoreFactory?: (
    projectRoot: string
  ) => GenerationSessionStore;
}

function runId(): string {
  return `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
}

export function createProductionDependencies(
  signal?: AbortSignal,
  options: ProductionDependencyOptions = {}
): CliDependencies {
  const runner = new NodeProcessRunner();
  const adb = new AdbAdapter(runner);
  const androidCli = new AndroidCliAdapter(runner);
  const gradle = new GradleAdapter(runner);
  const clock = new SystemClock();
  const generationStoreFactory = options.generationStoreFactory
    ?? ((projectRoot: string): GenerationSessionStore => (
      new FileSystemGenerationSessionStore(projectRoot)
    ));
  const contextValidator = new ContextValidator(new NodeProjectFileInspector());
  return {
    ...(signal === undefined ? {} : { signal }),
    doctor: new DoctorService({
      runner,
      adb,
      nodeVersion: process.version,
      checkGradleWrapper: async (projectRoot): Promise<boolean> => {
        try {
          await access(join(projectRoot, "gradlew"), constants.X_OK);
          return true;
        } catch {
          return false;
        }
      },
      checkAndroidPermissions: async (
        deviceSerial,
        signal
      ): Promise<{
        status: "passed" | "failed";
        message?: string | undefined;
      }> => {
        const directory = await mkdtemp(join(tmpdir(), "taphound-doctor-"));
        try {
          const result = await androidCli.captureScreen({
            outputPath: join(directory, "screen.png"),
            deviceSerial,
            ...(signal === undefined ? {} : { signal })
          });
          if (
            result.exitCode !== 0
            || result.spawnError !== undefined
            || result.cancelled
            || result.timedOut
          ) {
            return {
              status: "failed" as const,
              message: result.stderr.trim()
                || result.spawnError
                || "Android screen capture permission probe failed"
            };
          }
          return { status: "passed" as const };
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }),
    recorder: new RecorderService({
      gradle,
      androidCli,
      adb,
      clock,
      prompt: new InquirerRecorderPrompt(),
      journeyWriter: new FileSystemJourneyWriter()
    }),
    verifier: new VerifyRuntime({
      gradle,
      androidCli,
      adb,
      clock,
      artifactStore: new FileSystemArtifactStore(),
      reportWriter: new ReportWriter(),
      now: () => new Date(),
      createRunId: runId
    }),
    projectDescriber: new ProjectDescriber(androidCli),
    contextValidator,
    generationStarter: {
      start: async (input): Promise<
        Awaited<ReturnType<GenerationStarter["start"]>>
      > => new GenerationStarter({
        contextValidator,
        store: generationStoreFactory(input.projectRoot),
        now: (): Date => new Date(),
        generateId: randomUUID,
        randomBytes
      }).start(input)
    },
    runtimeObserver: {
      observe: async ({ projectRoot, ...input }): Promise<RuntimeObservation> => (
        new RuntimeObserver({
          store: generationStoreFactory(projectRoot),
          adb,
          androidCli,
          now: () => new Date(),
          createAttemptId: randomUUID
        }).observe(input)
      )
    },
    generationRuntime: ({ projectRoot, config }): GenerationCliRuntime => {
      const store = generationStoreFactory(projectRoot);
      const prompt = new InquirerGenerationPrompt();
      const observer = new RuntimeObserver({
        store,
        adb,
        androidCli,
        now: (): Date => new Date(),
        createAttemptId: randomUUID
      });
      const freshnessGuard = new SnapshotReobservationGuard({
        store,
        adb,
        androidCli,
        now: (): Date => new Date()
      });
      const confirmation = new GenerationConfirmationService({
        store,
        prompt,
        now: (): Date => new Date(),
        generateChallengeId: randomUUID,
        confirmationTtlMs: 5 * 60_000
      });
      const executor = new GenerationStepExecutor({
        store,
        freshnessGuard,
        adb,
        androidCli,
        clock,
        idle: config.idle,
        now: (): Date => new Date(),
        generateAttemptId: randomUUID,
        clearApprovedConfirmation: async (
          generationId,
          challenge
        ): Promise<void> => confirmation.clearApproved({
          generationId,
          challenge
        })
      });
      const publisher = new GenerationPublisher({
        store,
        journeyWriter: new FileSystemJourneyWriter(),
        metaWriter: new FileSystemGenerationMetaWriter()
      });
      const finalizer = new GenerationFinalizer({
        store,
        contextValidator,
        adb,
        verifyRuntime: new VerifyRuntime({
          gradle,
          androidCli,
          adb,
          clock,
          artifactStore: new FileSystemArtifactStore(),
          reportWriter: new ReportWriter(),
          now: (): Date => new Date(),
          createRunId: runId
        }),
        publisher,
        generateAttemptId: randomUUID
      });
      return {
        confirmation,
        executor,
        observer,
        finalizer,
        readSession: (id): Promise<GenerationSession> => store.read(id)
      };
    },
    readJson: async (path): Promise<unknown> => JSON.parse(
      await readFile(path, "utf8")
    ) as unknown,
    cwd: () => process.cwd(),
    stdout: {
      write: (content): void => {
        process.stdout.write(content);
      }
    },
    stderr: {
      write: (content): void => {
        process.stderr.write(content);
      }
    },
    setExitCode: (code): void => {
      process.exitCode = code;
    }
  };
}
