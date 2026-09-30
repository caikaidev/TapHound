import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { AdbAdapter } from "../adapters/adb/adb-adapter.js";
import { AdbRuntimeBackend } from "../adapters/runtime/adb-runtime-backend.js";
import { SharedSessionRuntimeBackend } from "../adapters/runtime/shared-session-runtime-backend.js";
import {
  SessionBackedScreenshotAdapter,
  SessionBackedUiSnapshotProviderFactory
} from "../adapters/runtime/session-backed-ports.js";
import { runtimeSessionPortViews } from "../adapters/runtime/session-adb-view.js";
import { FileSystemDiagnosticsJournal } from "../adapters/filesystem/diagnostics-journal.js";
import { UiCaptureTelemetry } from "../application/diagnostics/ui-capture-telemetry.js";
import { ObservedUiSnapshotProviderFactory } from "../application/ui/observed-ui-snapshot-provider.js";
import {
  DiagnosticsExporter,
  type DiagnosticsExportInput
} from "../application/diagnostics/diagnostics-exporter.js";
import type { DiagnosticsBundle } from "../domain/diagnostics.js";
import { readCliVersion } from "./version.js";
import {
  diagnosticsEnabled,
  diagnosticsHost,
  type CliDiagnostics
} from "./diagnostics-recorder.js";
import { MobileMcpRuntimeBackend } from "../adapters/runtime/mobile-mcp/mobile-mcp-runtime-backend.js";
import { McpToolClient } from "../adapters/runtime/mobile-mcp/mcp-tool-client.js";
import {
  isMobileMcpSpawnFailureDetail,
  mobileMcpServerUnavailableMessage
} from "../adapters/runtime/mobile-mcp/mobile-mcp-errors.js";
import type { MobileMcpTools } from "../adapters/runtime/mobile-mcp/mobile-mcp-tools.js";
import {
  SystemUiAutomatorSnapshotProviderFactory
} from "../adapters/adb/system-uiautomator-snapshot-provider.js";
import { AndroidCliAdapter } from "../adapters/android-cli/android-cli-adapter.js";
import {
  AndroidCliSnapshotProviderFactory
} from "../adapters/android-cli/android-cli-snapshot-provider.js";
import {
  AppiumUiSnapshotProviderFactory
} from "../adapters/appium/appium-ui-snapshot-provider.js";
import { checkAppiumUiAutomator2 } from "../adapters/appium/appium-doctor.js";
import {
  AutoUiSnapshotProviderFactory
} from "../adapters/ui/auto-ui-snapshot-provider.js";
import {
  CachedUiSnapshotProviderFactory
} from "../application/ui/cached-ui-snapshot-provider.js";
import { CameraProbeAdapter } from "../adapters/camera/camera-probe-adapter.js";
import type { Clock } from "../ports/clock.js";
import { SystemClock } from "../adapters/clock/system-clock.js";
import { FileSystemArtifactStore } from "../adapters/filesystem/artifact-store.js";
import { FileSystemContextDocumentWriter } from "../adapters/filesystem/context-document-writer.js";
import { FileSystemGenerationMetaWriter } from "../adapters/filesystem/generation-meta-writer.js";
import { FileSystemGenerationSessionStore } from "../adapters/filesystem/generation-session-store.js";
import { FileSystemJourneyWriter } from "../adapters/filesystem/journey-writer.js";
import { FileSystemKnowledgeRegistry } from "../adapters/filesystem/knowledge-registry.js";
import {
  FileSystemJourneyCompositionStore
} from "../adapters/filesystem/journey-composition-store.js";
import {
  FileSystemExternalFlowRegistry
} from "../adapters/filesystem/external-flow-registry.js";
import { NodeProjectFileInspector } from "../adapters/filesystem/project-file-inspector.js";
import { NodeProjectInventoryInspector } from "../adapters/filesystem/project-inventory-inspector.js";
import {
  GradleProjectModuleDiscoverer
} from "../adapters/filesystem/project-module-discoverer.js";
import {
  AndroidProjectIdentityInspector
} from "../adapters/filesystem/project-identity-inspector.js";
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
import { InquirerAlignPrompt } from "../adapters/prompt/inquirer-align-prompt.js";
import { AlignService, type AlignCameraResult } from "../application/align/align-service.js";
import {
  ObserveService,
  type ObserveInput
} from "../application/observe/observe-service.js";
import type { ObserveReport } from "../domain/observation.js";
import { ContextGenerator } from "../application/context/context-generator.js";
import { ContextRehasher } from "../application/context/context-rehasher.js";
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
  GenerationReopenService
} from "../application/generation/generation-reopen-service.js";
import {
  GenerationConfigService,
  type GenerationIdlePolicyPatch
} from "../application/generation/generation-config-service.js";
import {
  GenerationReplaceService,
  type GenerationReplaceResult
} from "../application/generation/generation-replace-service.js";
import {
  GenerationStarter,
  GenerationOperationError,
  hashGenerationBinding,
  type GenerationStartInput
} from "../application/generation/generation-starter.js";
import { readGenerationContextSnapshot } from "../application/generation/generation-context-snapshot.js";
import type {
  ResolvedProjectContext,
  ProjectContextModule
} from "../domain/project-context.js";
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
import { ExternalFlowResolver } from "../application/journey/external-flow-resolver.js";
import {
  KnowledgeLoadError,
  KnowledgeLoader
} from "../application/knowledge/knowledge-loader.js";
import {
  KnowledgeAnchorResolver
} from "../application/knowledge/anchor-resolver.js";
import {
  ImpactResolver
} from "../application/impact/impact-resolver.js";
import { NodeGitDiff } from "../adapters/git/node-git-diff.js";
import { ProjectDescriber } from "../application/project/project-describer.js";
import { RecorderService, type RecordInput, type RecordResult } from "../application/recorder/recorder-service.js";
import { ReportWriter } from "../application/report/report-writer.js";
import {
  ContractVerifier,
  type ContractVerifyInput,
  type ContractVerifyResult
} from "../application/contract/contract-verifier.js";
import { ContractLoader } from "../application/contract/contract-loader.js";
import { ContractReviewMerger } from "../application/contract/contract-review.js";
import { BaselineService } from "../application/checkpoint/baseline-service.js";
import { FailureClassifier } from "../application/diagnosis/failure-classifier.js";
import type { ContractVerdictView } from "../domain/contract.js";
import { TapHoundReportV4Schema } from "../domain/report.js";
import type { FailureClassification } from "../domain/failure-classification.js";
import { VerifyRuntime, type VerifyInput, type VerifyResult } from "../application/runtime/verify-runtime.js";
import { IdleWaiter } from "../application/wait/idle-waiter.js";
import { deviceIdentityResolver } from "../application/wait/idle-profiles.js";
import type { TapHoundConfig } from "../domain/config.js";
import {
  resolveRuntimeBackendId,
  type RuntimeBackendChoice
} from "../domain/runtime.js";
import type { AdbPort } from "../ports/adb.js";
import type { AnchorResolverPort } from "../ports/anchor-resolver.js";
import type {
  GitDiffPort
} from "../ports/git-diff.js";
import type {
  ImpactSet,
  ChangeSet
} from "../domain/impact.js";
import type { Journey } from "../domain/journey.js";
import {
  withRuntimeSession,
  type RuntimeBackend,
  type RuntimeSessionOpener
} from "../ports/runtime-backend.js";
import type { ScreenshotPort } from "../ports/screenshot.js";
import type { UiSnapshotProviderFactory } from "../ports/ui-snapshot.js";
import type { UiStabilityProbe } from "../ports/ui-stability.js";
import type { UiBackendSelection } from "../domain/ui-backend.js";
import type { InitResult } from "../domain/init.js";
import {
  verificationPhaseLabel,
  type GenerationSession
} from "../domain/generation.js";
import type { InitPromptPort } from "../ports/init-prompt.js";
import type { RecorderPromptPort } from "../ports/recorder-prompt.js";
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
import type {
  KnowledgeRehashResult,
  LoadedKnowledgeBundle
} from "../ports/knowledge-registry.js";
import { isErrnoException } from "../shared/errors.js";
import { readRuntimeBackendChoice } from "./runtime-selection.js";
import { CONTEXT_INDEX_PATH } from "../domain/workspace.js";
import { JourneySchema } from "../domain/journey.js";
import { configMismatchMessage } from "../application/generation/binding-mismatch.js";

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
  reopen: Pick<GenerationReopenService, "reopen">;
  archive: (id: string) => Promise<GenerationSession>;
  list: () => Promise<readonly GenerationSession[]>;
  readSession: (id: string) => Promise<GenerationSession>;
  readContextSnapshot: (id: string) => Promise<ResolvedProjectContext>;
  assertConfigIdentity: (id: string) => Promise<void>;
  updateIdlePolicy: (
    id: string,
    patch: GenerationIdlePolicyPatch
  ) => Promise<GenerationSession>;
  replace: (input: {
    generationId: string;
    stepIndex: number;
    projectRoot: string;
    config: TapHoundConfig;
    toolVersions: Record<string, string>;
    manualReplay?: boolean | undefined;
    signal?: AbortSignal | undefined;
  }) => Promise<GenerationReplaceResult>;
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
  contractVerifier?: {
    verify: (input: ContractVerifyInput) => Promise<ContractVerifyResult>;
  } | undefined;
  contractLoader?: Pick<ContractLoader, "load"> | undefined;
  baselineService?: Pick<BaselineService, "captureFromReport" | "write" | "compare"> | undefined;
  failureClassifier?: {
    classify: (reportPath: string) => Promise<FailureClassification>;
  } | undefined;
  contractReview?: {
    merge: ContractReviewMerger["merge"];
    writeVerdict: (input: {
      verdictPath: string;
      view: ContractVerdictView;
    }) => Promise<void>;
  } | undefined;
  projectDescriber: Pick<ProjectDescriber, "describe">;
  contextValidator: Pick<ContextValidator, "validate">;
  contextLoader: Pick<ContextLoader, "load" | "readIndex">;
  contextRefresher: Pick<ContextRefresher, "refresh">;
  contextGenerator: Pick<ContextGenerator, "generate">;
  contextRehasher: Pick<ContextRehasher, "rehash">;
  journeyResolver?: Pick<
    JourneyResolver,
    "resolve" | "resolveFlow" | "listFlows"
  > | undefined;
  journeyCompositionStore?: Pick<
    JourneyCompositionStore,
    "writeText" | "read" | "listJourneyPaths" | "readJourneyMeta"
  > | undefined;
  externalFlowResolver?: Pick<
    ExternalFlowResolver,
    "resolve" | "list"
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
  align: {
    alignCamera: (input: {
      projectRoot: string;
      deviceSerial?: string | undefined;
      force?: boolean | undefined;
      json: boolean;
      signal?: AbortSignal | undefined;
    }) => Promise<AlignCameraResult>;
  };
  observer: (
    layoutTimeoutMs: number,
    backend?: UiBackendSelection,
    cacheEnabled?: boolean
  ) => {
    observe: (input: ObserveInput) => Promise<ObserveReport>;
  };
  workspaceLayout: WorkspaceLayoutPort;
  impact?: {
    resolve: (input: {
      projectRoot: string;
      packageName: string;
      changeSet: ChangeSet;
    }) => Promise<ImpactSet>;
  } | undefined;
  gitDiff?: GitDiffPort | undefined;
  knowledge?: {
    load: (input: {
      projectRoot: string;
      packageName?: string | undefined;
      expectedKnowledgeHash?: string | undefined;
    }) => Promise<LoadedKnowledgeBundle>;
    rehash: (input: {
      projectRoot: string;
      packageName: string;
    }) => Promise<KnowledgeRehashResult>;
  } | undefined;
  readJson: (path: string) => Promise<unknown>;
  readFile: (path: string) => Promise<Buffer>;
  /** Atomically publishes a verify process receipt beside its report. */
  writeVerifyReceipt?: ((path: string, content: string) => Promise<void>) | undefined;
  cwd: () => string;
  stdout: TextOutput;
  stderr: TextOutput;
  setExitCode: (code: number) => void;
  close?: (() => Promise<void>) | undefined;
  /** Local diagnostics journal; absent in tests and when disabled. */
  diagnostics?: CliDiagnostics | undefined;
  diagnosticsExport?: {
    export: (input: DiagnosticsExportInput) => Promise<DiagnosticsBundle>;
    write: (path: string, content: string) => Promise<void>;
  } | undefined;
}

export interface ProductionDependencyOptions {
  generationStoreFactory?: (
    projectRoot: string
  ) => GenerationSessionStore;
  runtimeBackendChoice?: RuntimeBackendChoice | undefined;
  mobileMcpToolsFactory?: (() => MobileMcpTools) | undefined;
  /**
   * Replaces the device backend while keeping every other production wire.
   * Used by the simulated-device parity harness; the CLI never sets it.
   */
  runtimeBackend?: RuntimeBackend | undefined;
  /** Single time source for waits, polling, and cache TTLs (tests inject a virtual clock). */
  clock?: Clock | undefined;
  /** Replaces the interactive Recorder prompt (the parity harness scripts it). */
  recorderPrompt?: RecorderPromptPort | undefined;
}

function runId(): string {
  return `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
}

export function loadKnowledgeResilient(
  load: (input: {
    projectRoot: string;
    packageName: string;
  }) => Promise<LoadedKnowledgeBundle>,
  input: {
    projectRoot: string;
    packageName: string;
  }
): Promise<LoadedKnowledgeBundle> {
  return load(input).catch((error: unknown) => {
    if (
      (isErrnoException(error) && error.code === "ENOENT")
      || (
        error instanceof KnowledgeLoadError
        && error.code === "KNOWLEDGE_NOT_FOUND"
      )
    ) {
      return {
        index: {
          version: 1,
          packageName: input.packageName,
          revision: 0,
          anchors: [],
          screens: []
        },
        indexSha256: "0".repeat(64),
        knowledgeHash: "0".repeat(64),
        anchors: [],
        screens: []
      } satisfies LoadedKnowledgeBundle;
    }
    throw error;
  });
}

export function createProductionDependencies(
  signal?: AbortSignal,
  options: ProductionDependencyOptions = {}
): CliDependencies {
  const backendId = resolveRuntimeBackendId(
    options.runtimeBackendChoice ?? readRuntimeBackendChoice(process.env)
  );
  const runner = new NodeProcessRunner();
  const clock = options.clock ?? new SystemClock();
  const now = (): number => clock.now();
  const permissionCaptureTimeoutMs = 10_000;
  const uiTelemetry = new UiCaptureTelemetry();
  const diagnosticsJournal = new FileSystemDiagnosticsJournal();
  const observed = (source: UiSnapshotProviderFactory): UiSnapshotProviderFactory => (
    new ObservedUiSnapshotProviderFactory(source, uiTelemetry, now)
  );
  let backend: RuntimeBackend;
  let screenshots: ScreenshotPort;
  let uiSnapshots: UiSnapshotProviderFactory;
  let sharedBackend: SharedSessionRuntimeBackend | undefined;
  if (options.runtimeBackend !== undefined) {
    backend = options.runtimeBackend;
    screenshots = new SessionBackedScreenshotAdapter(backend);
    uiSnapshots = new CachedUiSnapshotProviderFactory(
      observed(new SessionBackedUiSnapshotProviderFactory(backend)),
      now
    );
  } else if (backendId === "mobile-mcp") {
    const shared = new SharedSessionRuntimeBackend(
      new MobileMcpRuntimeBackend({
        createTools: options.mobileMcpToolsFactory
          ?? ((): MobileMcpTools => new McpToolClient())
      })
    );
    sharedBackend = shared;
    backend = shared;
    screenshots = new SessionBackedScreenshotAdapter(backend);
    uiSnapshots = new CachedUiSnapshotProviderFactory(
      observed(new SessionBackedUiSnapshotProviderFactory(backend)),
      now
    );
  } else {
    const adbAdapter = new AdbAdapter(runner);
    const androidCli = new AndroidCliAdapter(runner);
    const autoSnapshots = new CachedUiSnapshotProviderFactory(
      observed(new AutoUiSnapshotProviderFactory(
        new SystemUiAutomatorSnapshotProviderFactory(runner),
        new AndroidCliSnapshotProviderFactory(runner),
        new AppiumUiSnapshotProviderFactory(runner, undefined, {
          onSessionRecovery: (succeeded): void => {
            uiTelemetry.sessionRecovered("appium-uiautomator2", succeeded);
          }
        })
      )),
      now
    );
    const adbBackend = new AdbRuntimeBackend({
      adb: adbAdapter,
      screenshots: androidCli,
      annotatedScreens: androidCli,
      uiStability: androidCli,
      uiSnapshots: autoSnapshots
    });
    backend = adbBackend;
    screenshots = androidCli;
    uiSnapshots = autoSnapshots;
  }
  const sessions: RuntimeSessionOpener = backend;
  // Device-wide probes (listing, install state) borrow a session per call.
  const devices: Pick<AdbPort, "devices" | "isInstalled"> = {
    devices: (signal) => backend.listDevices(signal),
    isInstalled: (identity) => withRuntimeSession(
      backend,
      identity.deviceSerial,
      identity.signal,
      (session) => session.isInstalled({
        packageName: identity.packageName,
        ...(identity.signal === undefined ? {} : { signal: identity.signal }),
        ...(identity.timeoutMs === undefined
          ? {}
          : { timeoutMs: identity.timeoutMs })
      })
    )
  };
  const waitUntilIdle = (
    deviceSerial: string,
    config: Parameters<IdleWaiter["waitUntilIdle"]>[0],
    signal: AbortSignal | undefined,
    packageName: string,
    stability: UiStabilityProbe,
    device: Pick<AdbPort, "deviceIdentity">
  ): ReturnType<IdleWaiter["waitUntilIdle"]> => new IdleWaiter(
    stability,
    clock,
    deviceSerial,
    packageName,
    deviceIdentityResolver(device, {
      packageName,
      deviceSerial,
      timeoutMs: config.timeoutMs
    })
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
  const moduleDiscoverer = new GradleProjectModuleDiscoverer();
  const identityInspector = new AndroidProjectIdentityInspector();
  const contextWriter = new FileSystemContextDocumentWriter();
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
    writer: contextWriter
  });
  const contextGenerator = new ContextGenerator({
    discoverer: moduleDiscoverer,
    identity: identityInspector,
    files: projectFiles,
    inventory: projectInventory,
    writer: contextWriter
  });
  const contextRehasher = new ContextRehasher({
    files: projectFiles,
    loader: contextLoader,
    writer: contextWriter
  });
  const journeyCompositionStore = new FileSystemJourneyCompositionStore();
  const journeyResolver = new JourneyResolver(journeyCompositionStore);
  const builtinFlowsRoot = resolvePath(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "assets",
    "external-flows"
  );
  const externalFlowRegistry = new FileSystemExternalFlowRegistry(
    builtinFlowsRoot
  );
  const externalFlowResolver = new ExternalFlowResolver({
    registry: externalFlowRegistry
  });
  const knowledgeRegistry = new FileSystemKnowledgeRegistry();
  const knowledgeLoader = new KnowledgeLoader(knowledgeRegistry);
  const productionContractLoader = new ContractLoader({
    readText: (path: string): Promise<string> => readFile(path, "utf8")
  });
  const productionContractReview = new ContractReviewMerger({
    now: (): Date => new Date()
  });
  const productionBaselineService = new BaselineService({
    readText: (path: string): Promise<string> => readFile(path, "utf8"),
    writeText: (path: string, content: string): Promise<void> => {
      const directory = dirname(path);
      return mkdir(directory, { recursive: true }).then(() => (
        writeFile(path, content, "utf8")
      ));
    },
    now: (): Date => new Date()
  });
  const productionFailureClassifier = new FailureClassifier({
    now: (): Date => new Date()
  });
  const productionContractVerifier = new ContractVerifier({
    verify: (input): Promise<VerifyResult> => productionVerifyRuntime.verify(input),
    loadKnowledge: (input): Promise<LoadedKnowledgeBundle> => (
      knowledgeRegistry.load(input.projectRoot)
    ),
    readText: (path: string): Promise<string> => readFile(path, "utf8"),
    writeVerdict: async ({ reportPath, verdict }): Promise<void> => {
      const directory = dirname(reportPath);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "verdict.json"),
        `${JSON.stringify(verdict, null, 2)}\n`,
        "utf8"
      );
    },
    now: (): Date => new Date()
  });
  const productionVerifyRuntime = new VerifyRuntime({
    sessions,
    sessionPorts: runtimeSessionPortViews,
    clock,
    artifactStore: new FileSystemArtifactStore(),
    reportWriter: new ReportWriter(),
    now: (): Date => new Date(),
    createRunId: runId,
    anchorResolverFor: (projectRoot: string): AnchorResolverPort => (
      new KnowledgeAnchorResolver(knowledgeRegistry, projectRoot)
    ),
    loadKnowledge: (input): Promise<LoadedKnowledgeBundle> => (
      knowledgeRegistry.load(input.projectRoot)
    )
  });
  const gitDiff = new NodeGitDiff(runner);
  const impactResolver = new ImpactResolver({
    loadContext: async (input: {
      projectRoot: string;
    }): Promise<{
      context: ResolvedProjectContext;
      modules: ProjectContextModule[];
    }> => {
      const loaded = await contextLoader.load({
        projectRoot: input.projectRoot,
        contextPath: join(input.projectRoot, CONTEXT_INDEX_PATH),
        allowIncomplete: true
      });
      return { context: loaded.context, modules: loaded.modules };
    },
    loadKnowledge: (input: {
      projectRoot: string;
      packageName: string;
    }): Promise<LoadedKnowledgeBundle> => loadKnowledgeResilient(
      knowledgeLoader.load.bind(knowledgeLoader),
      input
    ),
    listJourneyPaths: (input: {
      projectRoot: string;
    }): Promise<readonly string[]> => (
      journeyCompositionStore.listJourneyPaths(input.projectRoot)
    ),
    readJourney: async (input: {
      projectRoot: string;
      path: string;
    }): Promise<Journey | null> => {
      const bytes = await journeyCompositionStore.read({
        projectRoot: input.projectRoot,
        relativePath: input.path
      });
      try {
        return JourneySchema.parse(JSON.parse(bytes.toString("utf8")));
      } catch {
        return null;
      }
    }
  });
  return {
    ...(signal === undefined ? {} : { signal }),
    ...(sharedBackend === undefined
      ? {}
      : { close: (): Promise<void> => sharedBackend.close() }),
    doctor: new DoctorService({
      runner,
      adb: devices,
      nodeVersion: process.version,
      runtimeBackendId: backendId,
      checkAndroidPermissions: async (
        deviceSerial,
        signal
      ): Promise<{
        status: "passed" | "failed";
        message?: string | undefined;
      }> => {
        const directory = await mkdtemp(join(tmpdir(), "taphound-doctor-"));
        try {
          const result = await screenshots.capture({
            outputPath: join(directory, "screen.png"),
            deviceSerial,
            timeoutMs: permissionCaptureTimeoutMs,
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
              message: result.timedOut
                ? "Android screen capture permission probe timed out after 10 seconds"
                : result.stderr.trim()
                || result.spawnError
                || "Android screen capture permission probe failed"
            };
          }
          return { status: "passed" as const };
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
      checkAppiumUiAutomator2: async (appiumSignal) => (
        checkAppiumUiAutomator2(runner, appiumSignal)
      ),
      checkMobileMcpServer: async (mcpSignal): Promise<{
        status: "passed" | "failed";
        version?: string | undefined;
        message?: string | undefined;
      }> => {
        const result = await runner.run({
          executable: "mcp-server-mobile",
          args: ["--version"],
          ...(mcpSignal === undefined ? {} : { signal: mcpSignal })
        });
        if (
          result.exitCode !== 0
          || result.spawnError !== undefined
          || result.cancelled
          || result.timedOut
        ) {
          const detail = result.stderr.trim()
            || result.spawnError
            || "mcp-server-mobile check failed";
          return {
            status: "failed" as const,
            message: isMobileMcpSpawnFailureDetail(detail)
              ? mobileMcpServerUnavailableMessage("mcp-server-mobile", detail)
              : detail
          };
        }
        return {
          status: "passed" as const,
          version: result.stdout.trim().split(/\r?\n/, 1)[0] ?? "unknown"
        };
      }
    }),
    recorder: new RecorderService({
      sessions,
      sessionPorts: runtimeSessionPortViews,
      clock,
      prompt: options.recorderPrompt ?? new InquirerRecorderPrompt(),
      journeyWriter: new FileSystemJourneyWriter()
    }),
      verifier: productionVerifyRuntime,
      contractLoader: productionContractLoader,
      contractVerifier: productionContractVerifier,
      baselineService: productionBaselineService,
      failureClassifier: {
        classify: async (reportPath: string): Promise<FailureClassification> => {
          const text = await readFile(reportPath, "utf8");
          const report = TapHoundReportV4Schema.parse(JSON.parse(text));
          return productionFailureClassifier.classify({ report });
        }
      },
      contractReview: {
        merge: productionContractReview.merge,
        writeVerdict: async ({ verdictPath, view }): Promise<void> => {
          const directory = dirname(verdictPath);
          await mkdir(directory, { recursive: true });
          await writeFile(verdictPath, `${JSON.stringify(view, null, 2)}\n`, "utf8");
        }
      },
      projectDescriber: new ProjectDescriber({
        discoverer: moduleDiscoverer,
        identity: identityInspector
      }),
    contextValidator,
    contextLoader,
    contextRefresher,
    contextGenerator,
    contextRehasher,
    journeyResolver,
    journeyCompositionStore,
    externalFlowResolver,
    init: new InitService({
      installer: new FileSystemSkillInstaller(),
      cwd: process.cwd(),
      homedir: homedir()
    }),
    initPrompt: new InquirerInitPrompt(),
    align: new AlignService({
      adb: devices,
      probe: new CameraProbeAdapter({
        sessions,
        sessionPorts: runtimeSessionPortViews,
        uiSnapshots,
        now: () => Date.now(),
        sleep: async (ms: number): Promise<void> => {
          await new Promise((resolve) => setTimeout(resolve, ms));
        }
      }),
      prompt: new InquirerAlignPrompt(),
      registry: externalFlowRegistry
    }),
    observer: (
      layoutTimeoutMs: number,
      backend?: UiBackendSelection,
      cacheEnabled?: boolean
    ): {
      observe: (input: ObserveInput) => Promise<ObserveReport>;
    } => {
      const service = new ObserveService({
        sessions,
        layoutTimeoutMs,
        ...(backend === undefined ? {} : { backend }),
        ...(cacheEnabled === undefined ? {} : { cacheEnabled })
      });
      return {
        observe: (input): Promise<ObserveReport> => service.observe(input)
      };
    },
    workspaceLayout: new FileSystemWorkspaceLayout(),
    impact: {
      resolve: (input): Promise<ImpactSet> => impactResolver.resolve(input)
    },
    gitDiff,
    knowledge: {
      load: (input): Promise<LoadedKnowledgeBundle> => knowledgeLoader.load(input),
      rehash: (input): Promise<KnowledgeRehashResult> => (
        knowledgeRegistry.rehash(input.projectRoot, input.packageName)
      )
    },
    generationStarter: {
      start: async (input): Promise<
        Awaited<ReturnType<GenerationStarter["start"]>>
      > => new GenerationStarter({
        contextValidator,
        appPreparer: new GenerationAppPreparer({
              sessions,
              sessionPorts: runtimeSessionPortViews,
              clock
            }),
        uiSnapshots,
        store: generationStoreFactory(input.projectRoot),
        now: (): Date => new Date(),
        generateId: randomUUID,
        randomBytes
      }).start(input)
    },
    runtimeObserver: {
      observe: async (
        { projectRoot, ...input }
      ): Promise<RuntimeObservation> => (
        new RuntimeObserver({
          store: generationStoreFactory(projectRoot),
          sessions,
          sessionPorts: runtimeSessionPortViews,
          waitUntilIdle,
          now: () => new Date(),
          createAttemptId: randomUUID
        }).observe(input)
      )
    },
    generationRuntime: ({
      projectRoot,
      config
    }): GenerationCliRuntime => {
      const store = generationStoreFactory(projectRoot);
      const prompt = new InquirerGenerationPrompt();
      const observer = new RuntimeObserver({
        store,
        sessions,
        sessionPorts: runtimeSessionPortViews,
        waitUntilIdle,
        now: (): Date => new Date(),
        createAttemptId: randomUUID,
        uiCacheEnabled: config.ui?.cacheEnabled ?? true,
        uiSnapshotTimeoutMs: config.ui?.snapshotTimeoutMs
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
        createFreshnessGuard: (
          uiSnapshotProvider,
          views
        ): Pick<SnapshotReobservationGuard, "assertFresh"> => (
          new SnapshotReobservationGuard({
            store,
            adb: views.adb,
            uiSnapshotProvider,
            now: (): Date => new Date(),
            uiSnapshotTimeoutMs: config.ui?.snapshotTimeoutMs
          })
        ),
        sessions,
        sessionPorts: runtimeSessionPortViews,
        uiCacheEnabled: config.ui?.cacheEnabled ?? true,
        clock,
        idle: config.idle,
        now: (): Date => new Date(),
        generateAttemptId: randomUUID,
        projectRoot,
        externalFlowResolver,
        clearApprovedConfirmation: async (
          generationId,
          challenge
        ): Promise<void> => confirmation.clearApproved({
          generationId,
          challenge
        }),
        observeNext: (observation): Promise<RuntimeObservation> => (
          observer.observeCollected({
            generationId: observation.generationId,
            runtime: observation.runtime,
            ...(observation.signal === undefined
              ? {}
              : { signal: observation.signal })
          })
        )
      });
      const publisher = new GenerationPublisher({
        store,
        journeyWriter: new FileSystemJourneyWriter(),
        metaWriter: new FileSystemGenerationMetaWriter()
      });
      const verifyRuntime = new VerifyRuntime({
        sessions,
        sessionPorts: runtimeSessionPortViews,
        clock,
        artifactStore: new FileSystemArtifactStore(),
        reportWriter: new ReportWriter(),
        now: (): Date => new Date(),
        createRunId: runId,
        anchorResolverFor: (projectRoot: string): AnchorResolverPort => (
          new KnowledgeAnchorResolver(knowledgeRegistry, projectRoot)
        )
      });
      const finalizer = new GenerationFinalizer({
        store,
        verifyRuntime,
        publisher,
        generateAttemptId: randomUUID,
        owner: { pid: process.pid, now: (): Date => new Date() },
        progress: (stage): void => {
          process.stderr.write(`TapHound finalize: ${stage}\n`);
        },
        replayProgress: (phase): void => {
          process.stderr.write(
            `TapHound finalize: ${verificationPhaseLabel(phase)}\n`
          );
        }
      });
      const recovery = new GenerationRecoveryService({
        store,
        now: (): Date => new Date(),
        ownerAlive: (pid): boolean => {
          try {
            process.kill(pid, 0);
            return true;
          } catch (error) {
            return !isErrnoException(error) || error.code !== "ESRCH";
          }
        }
      });
      const reopen = new GenerationReopenService({
        store,
        now: (): Date => new Date()
      });
      return {
        confirmation,
        executor,
        observer,
        finalizer,
        recovery,
        reopen,
        archive: async (id): Promise<GenerationSession> => {
          const current = await store.read(id);
          const next: GenerationSession = {
            ...current,
            revision: current.revision + 1,
            state: "archived"
          };
          await store.archive(id, current.revision, next);
          return next;
        },
        list: (): Promise<readonly GenerationSession[]> => store.list(),
        readSession: (id): Promise<GenerationSession> => store.read(id),
        readContextSnapshot: (id): Promise<ResolvedProjectContext> => (
          readGenerationContextSnapshot({ store }, id)
        ),
        assertConfigIdentity: async (id): Promise<void> => {
          const session = await store.read(id);
          const configHash = hashGenerationBinding(config);
          if (configHash !== session.bindings.configHash) {
            throw new GenerationOperationError(
              "CONFIG_INVALID",
              configMismatchMessage(session.bindings.configHash, configHash)
            );
          }
        },
        updateIdlePolicy: async (
          id: string,
          patch: GenerationIdlePolicyPatch
        ): Promise<GenerationSession> => (
          new GenerationConfigService({ store }).updateIdlePolicy({
            generationId: id,
            config,
            patch
          })
        ),
        replace: (input): Promise<GenerationReplaceResult> => (
          new GenerationReplaceService({
            store,
            observer,
            verifyRuntime,
            appPreparer: new GenerationAppPreparer({
              sessions,
              sessionPorts: runtimeSessionPortViews,
              clock
            })
          }).replace(input)
        )
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
    readFile: async (path): Promise<Buffer> => readFile(path),
    writeVerifyReceipt: async (path, content): Promise<void> => {
      const temporaryPath = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
        await rename(temporaryPath, path);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
    },
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
    },
    diagnosticsExport: {
      export: (input): Promise<DiagnosticsBundle> => new DiagnosticsExporter({
        journal: diagnosticsJournal,
        readJson: async (path): Promise<unknown> => JSON.parse(
          await readFile(path, "utf8")
        ) as unknown,
        now: (): Date => new Date(),
        taphoundVersion: readCliVersion(),
        host: diagnosticsHost()
      }).export(input),
      write: async (path, content): Promise<void> => {
        await mkdir(dirname(path), { recursive: true });
        const temporaryPath = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
          await rename(temporaryPath, path);
        } catch (error) {
          await rm(temporaryPath, { force: true });
          throw error;
        }
      }
    },
    ...(diagnosticsEnabled(process.env)
      ? {
          diagnostics: {
            journal: diagnosticsJournal,
            telemetry: uiTelemetry
          }
        }
      : {})
  };
}
