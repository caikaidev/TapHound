import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { AdbAdapter } from "../adapters/adb/adb-adapter.js";
import { AndroidCliAdapter } from "../adapters/android-cli/android-cli-adapter.js";
import { SystemClock } from "../adapters/clock/system-clock.js";
import { FileSystemArtifactStore } from "../adapters/filesystem/artifact-store.js";
import { FileSystemContextDocumentWriter } from "../adapters/filesystem/context-document-writer.js";
import { FileSystemGenerationMetaWriter } from "../adapters/filesystem/generation-meta-writer.js";
import { FileSystemGenerationSessionStore } from "../adapters/filesystem/generation-session-store.js";
import { FileSystemJourneyWriter } from "../adapters/filesystem/journey-writer.js";
import {
  FileSystemJourneyCompositionStore
} from "../adapters/filesystem/journey-composition-store.js";
import { NodeProjectFileInspector } from "../adapters/filesystem/project-file-inspector.js";
import { NodeProjectInventoryInspector } from "../adapters/filesystem/project-inventory-inspector.js";
import { FileSystemSkillInstaller } from "../adapters/filesystem/skill-installer.js";
import {
  FileSystemWorkspaceLayout
} from "../adapters/filesystem/workspace-layout.js";
import { NodeProcessRunner } from "../adapters/process/node-process-runner.js";
import {
  NodeDetachedProcessLauncher
} from "../adapters/process/node-detached-process-launcher.js";
import { InquirerRecorderPrompt } from "../adapters/prompt/inquirer-recorder-prompt.js";
import { InquirerGenerationPrompt } from "../adapters/prompt/inquirer-generation-prompt.js";
import { InquirerInitPrompt } from "../adapters/prompt/inquirer-init-prompt.js";
import { ContextValidator } from "../application/context/context-validator.js";
import { ContextLoader } from "../application/context/context-loader.js";
import { ContextRefresher } from "../application/context/context-refresher.js";
import { DoctorService } from "../application/doctor/doctor-service.js";
import type {
  DoctorReport,
  DoctorRunInput
} from "../application/doctor/doctor-service.js";
import {
  GenerationConfirmationService
} from "../application/generation/generation-confirmation-service.js";
import {
  GenerationAppPreparer
} from "../application/generation/generation-app-preparer.js";
import {
  GenerationFinalizer
} from "../application/generation/generation-finalizer.js";
import {
  GenerationPublisher
} from "../application/generation/generation-publisher.js";
import {
  GenerationRecoveryService
} from "../application/generation/generation-recovery-service.js";
import {
  GenerationStarter,
  GenerationOperationError,
  hashGenerationBinding,
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
import { InitService, type InitInput } from "../application/init/init-service.js";
import { JourneyResolver } from "../application/journey/journey-resolver.js";
import { ProjectDescriber } from "../application/project/project-describer.js";
import { RecorderService, type RecordInput, type RecordResult } from "../application/recorder/recorder-service.js";
import { ReportWriter } from "../application/report/report-writer.js";
import { VerifyRuntime, type VerifyInput, type VerifyResult } from "../application/runtime/verify-runtime.js";
import { IdleWaiter } from "../application/wait/idle-waiter.js";
import type { TapHoundConfig } from "../domain/config.js";
import type { InitResult } from "../domain/init.js";
import type { GenerationSession } from "../domain/generation.js";
import type { InitPromptPort } from "../ports/init-prompt.js";
import type {
  GenerationSessionStore
} from "../ports/generation-session-store.js";
import type {
  DetachedProcessLauncher
} from "../ports/detached-process-launcher.js";
import type { WorkspaceLayoutPort } from "../ports/workspace-layout.js";
import type {
  JourneyCompositionStore
} from "../ports/journey-composition-store.js";

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
  recovery: Pick<GenerationRecoveryService, "status" | "retry">;
  readSession: (id: string) => Promise<GenerationSession>;
  assertConfigIdentity: (id: string) => Promise<void>;
}

export interface CliDependencies {
  signal?: AbortSignal | undefined;
  doctor: {
    run: (input?: DoctorRunInput) => Promise<DoctorReport>;
  };
  recorder: {
    record: (input: RecordInput) => Promise<RecordResult>;
  };
  verifier: {
    verify: (input: VerifyInput) => Promise<VerifyResult>;
  };
  projectDescriber: Pick<ProjectDescriber, "describe">;
  contextValidator: Pick<ContextValidator, "validate">;
  contextLoader: Pick<ContextLoader, "load" | "readIndex">;
  contextRefresher: Pick<ContextRefresher, "refresh">;
  journeyResolver?: Pick<
    JourneyResolver,
    "resolve" | "resolveFlow" | "listFlows"
  > | undefined;
  journeyCompositionStore?: Pick<
    JourneyCompositionStore,
    "writeText"
  > | undefined;
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
  detachedProcess?: DetachedProcessLauncher | undefined;
  cliEntryPath?: string | undefined;
  createDetachedJobId?: (() => string) | undefined;
  init: {
    install: (input: InitInput) => Promise<InitResult>;
  };
  initPrompt: Pick<InitPromptPort, "selectAgents">;
  workspaceLayout: WorkspaceLayoutPort;
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
  const clock = new SystemClock();
  const waitUntilIdle = (
    deviceSerial: string,
    config: Parameters<IdleWaiter["waitUntilIdle"]>[0],
    signal?: AbortSignal,
    packageName?: string
  ): ReturnType<IdleWaiter["waitUntilIdle"]> => new IdleWaiter(
    androidCli,
    clock,
    deviceSerial,
    packageName
  ).waitUntilIdle(
    config,
    signal
  );
  const generationStoreFactory = options.generationStoreFactory
    ?? ((projectRoot: string): GenerationSessionStore => (
      new FileSystemGenerationSessionStore(projectRoot)
    ));
  const projectFiles = new NodeProjectFileInspector();
  const projectInventory = new NodeProjectInventoryInspector();
  const contextValidator = new ContextValidator(
    projectFiles,
    projectInventory
  );
  const contextLoader = new ContextLoader({
    files: projectFiles,
    inventory: projectInventory,
    readJson: async (path): Promise<unknown> => JSON.parse(
      await readFile(path, "utf8")
    ) as unknown
  });
  const contextRefresher = new ContextRefresher({
    files: projectFiles,
    inventory: projectInventory,
    loader: contextLoader,
    writer: new FileSystemContextDocumentWriter()
  });
  const journeyCompositionStore = new FileSystemJourneyCompositionStore();
  const journeyResolver = new JourneyResolver(journeyCompositionStore);
  return {
    ...(signal === undefined ? {} : { signal }),
    doctor: new DoctorService({
      runner,
      adb,
      nodeVersion: process.version,
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
      androidCli,
      adb,
      clock,
      prompt: new InquirerRecorderPrompt(),
      journeyWriter: new FileSystemJourneyWriter()
    }),
    verifier: new VerifyRuntime({
      androidCli,
      adb,
      clock,
      artifactStore: new FileSystemArtifactStore(),
      reportWriter: new ReportWriter(),
      now: () => new Date(),
      createRunId: runId
    }),
    projectDescriber: new ProjectDescriber(),
    contextValidator,
    contextLoader,
    contextRefresher,
    journeyResolver,
    journeyCompositionStore,
    init: new InitService({
      installer: new FileSystemSkillInstaller(),
      cwd: process.cwd(),
      homedir: homedir()
    }),
    initPrompt: new InquirerInitPrompt(),
    workspaceLayout: new FileSystemWorkspaceLayout(),
    generationStarter: {
      start: async (input): Promise<
        Awaited<ReturnType<GenerationStarter["start"]>>
      > => new GenerationStarter({
        contextValidator,
        appPreparer: new GenerationAppPreparer(adb, clock),
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
          waitUntilIdle,
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
        waitUntilIdle,
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
        }),
        observeNext: (input): Promise<RuntimeObservation> => observer.observeCollected({
          generationId: input.generationId,
          runtime: input.runtime,
          ...(input.signal === undefined ? {} : { signal: input.signal })
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
        verifyRuntime: new VerifyRuntime({
          androidCli,
          adb,
          clock,
          artifactStore: new FileSystemArtifactStore(),
          reportWriter: new ReportWriter(),
          now: (): Date => new Date(),
          createRunId: runId
        }),
        publisher,
        generateAttemptId: randomUUID,
        owner: { pid: process.pid, now: (): Date => new Date() },
        progress: (stage): void => {
          process.stderr.write(`TapHound finalize: ${stage}\n`);
        }
      });
      const recovery = new GenerationRecoveryService({
        store,
        now: (): Date => new Date(),
        ownerAlive: (pid): boolean => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        }
      });
      return {
        confirmation,
        executor,
        observer,
        finalizer,
        recovery,
        readSession: (id): Promise<GenerationSession> => store.read(id),
        assertConfigIdentity: async (id): Promise<void> => {
          const session = await store.read(id);
          if (hashGenerationBinding(config) !== session.bindings.configHash) {
            throw new GenerationOperationError(
              "CONFIG_INVALID",
              "Generation configuration does not match the authoritative session"
            );
          }
        }
      };
    },
    detachedProcess: new NodeDetachedProcessLauncher(),
    createDetachedJobId: randomUUID,
    ...(process.argv[1] === undefined
      ? {}
      : { cliEntryPath: process.argv[1] }),
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
