import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { AdbAdapter } from "../adapters/adb/adb-adapter.js";
import { AdbRuntimeBackend } from "../adapters/runtime/adb-runtime-backend.js";
import { RuntimeBackendAdbBridge } from "../adapters/runtime/runtime-backend-adb-bridge.js";
import { SharedSessionRuntimeBackend } from "../adapters/runtime/shared-session-runtime-backend.js";
import {
  SessionBackedScreenshotAdapter,
  SessionBackedUiSnapshotProviderFactory,
  SessionBackedUiStabilityAdapter
} from "../adapters/runtime/session-backed-ports.js";
import { runtimeSessionPortViews } from "../adapters/runtime/session-adb-view.js";
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
import { SystemClock } from "../adapters/clock/system-clock.js";
import { FileSystemArtifactStore } from "../adapters/filesystem/artifact-store.js";
import { FileSystemContextDocumentWriter } from "../adapters/filesystem/context-document-writer.js";
import { FileSystemGenerationMetaWriter } from "../adapters/filesystem/generation-meta-writer.js";
import { FileSystemGenerationSessionStore } from "../adapters/filesystem/generation-session-store.js";
import { FileSystemJourneyWriter } from "../adapters/filesystem/journey-writer.js";
import { FileSystemUiCacheStore } from "../adapters/filesystem/ui-cache-store.js";
import { FileSystemKnowledgeRegistry } from "../adapters/filesystem/knowledge-registry.js";
import { FileSystemBenchmarkStore } from "../adapters/filesystem/benchmark-store.js";
import type { BenchmarkStore } from "../ports/benchmark-store.js";
import {
  FileSystemKnowledgeReceiptStore
} from "../adapters/filesystem/knowledge-receipt-store.js";
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
import type { ResolvedProjectContext } from "../domain/project-context.js";
import {
  GenerationStepExecutor
} from "../application/generation/generation-step-executor.js";
import { GenerationPlanner } from "../application/generation/generation-planner.js";
import {
  RuntimeObserver,
  SnapshotReobservationGuard,
  type RuntimeObservation,
  type RuntimeObserveInput,
  type SnapshotPlanning
} from "../application/generation/runtime-observer.js";
import { InitService, type InitInput } from "../application/init/init-service.js";
import { JourneyResolver } from "../application/journey/journey-resolver.js";
import { ExternalFlowResolver } from "../application/journey/external-flow-resolver.js";
import { KnowledgeLoader } from "../application/knowledge/knowledge-loader.js";
import {
  KnowledgeAnchorResolver
} from "../application/knowledge/anchor-resolver.js";
import {
  KnowledgeReceiptRecorder
} from "../application/knowledge/receipt-recorder.js";
import {
  KnowledgeBootstrapper
} from "../application/knowledge/knowledge-bootstrapper.js";
import {
  KnowledgePromotionService
} from "../application/knowledge/promotion-service.js";
import {
  KnowledgeEvolutionService,
  type KnowledgeEvolutionResult
} from "../application/knowledge/knowledge-evolver.js";
import type {
  ActionResolutionResult
} from "../application/resolution/action-resolver.js";
import { ProjectDescriber } from "../application/project/project-describer.js";
import { RecorderService, type RecordInput, type RecordResult } from "../application/recorder/recorder-service.js";
import { ReportWriter } from "../application/report/report-writer.js";
import { VerifyRuntime, type VerifyInput, type VerifyResult } from "../application/runtime/verify-runtime.js";
import { IdleWaiter } from "../application/wait/idle-waiter.js";
import type { TapHoundConfig } from "../domain/config.js";
import {
  resolveRuntimeBackendId,
  type RuntimeBackendChoice
} from "../domain/runtime.js";
import type { AdbPort } from "../ports/adb.js";
import type { AnchorResolverPort } from "../ports/anchor-resolver.js";
import type { RuntimeSessionOpener } from "../ports/runtime-backend.js";
import type { ScreenshotPort } from "../ports/screenshot.js";
import type { UiSnapshotProviderFactory } from "../ports/ui-snapshot.js";
import type { UiStabilityProbe } from "../ports/ui-stability.js";
import type { UiBackendSelection } from "../domain/ui-backend.js";
import type { InitResult } from "../domain/init.js";
import type { RuntimeSnapshot } from "../domain/runtime-snapshot.js";
import type {
  KnowledgePromotion,
  KnowledgeReceipt
} from "../domain/knowledge-receipt.js";
import {
  verificationPhaseLabel,
  type GenerationSession
} from "../domain/generation.js";
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
import type {
  LoadedKnowledgeBundle,
  WriteKnowledgeBundleResult
} from "../ports/knowledge-registry.js";
import { isErrnoException } from "../shared/errors.js";
import { readRuntimeBackendChoice } from "./runtime-selection.js";

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
  archive: (id: string) => Promise<GenerationSession>;
  list: () => Promise<readonly GenerationSession[]>;
  readSession: (id: string) => Promise<GenerationSession>;
  readContextSnapshot: (
    id: string
  ) => Promise<ResolvedProjectContext | null>;
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
  resolvePlannedAction?: ((input: {
    session: GenerationSession;
    snapshot: RuntimeSnapshot;
  }) => Promise<ActionResolutionResult>) | undefined;
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
  uiCache?: {
    status: (projectRoot: string) => Promise<{
      directory: string;
      entries: number;
      bytes: number;
    }>;
    clear: (projectRoot: string) => Promise<void>;
  } | undefined;
  knowledge?: {
    load: (input: {
      projectRoot: string;
      packageName?: string | undefined;
      expectedKnowledgeHash?: string | undefined;
    }) => Promise<LoadedKnowledgeBundle>;
    bootstrap: (input: {
      projectRoot: string;
      packageName: string;
      modules: Parameters<KnowledgeBootstrapper["bootstrap"]>[0]["modules"];
      expectedKnowledgeHash?: string | undefined;
    }) => Promise<WriteKnowledgeBundleResult>;
    promote: (input: {
      projectRoot: string;
      packageName: string;
      promotion: KnowledgePromotion;
    }) => Promise<WriteKnowledgeBundleResult>;
    evolve: (input: {
      projectRoot: string;
      packageName: string;
      expectedKnowledgeHash?: string | undefined;
    }) => Promise<KnowledgeEvolutionResult>;
    listReceipts: (
      projectRoot: string
    ) => Promise<readonly KnowledgeReceipt[]>;
  } | undefined;
  benchmark?: {
    store: BenchmarkStore;
  } | undefined;
  readJson: (path: string) => Promise<unknown>;
  cwd: () => string;
  stdout: TextOutput;
  stderr: TextOutput;
  setExitCode: (code: number) => void;
  close?: (() => Promise<void>) | undefined;
}

export interface ProductionDependencyOptions {
  generationStoreFactory?: (
    projectRoot: string
  ) => GenerationSessionStore;
  runtimeBackendChoice?: RuntimeBackendChoice | undefined;
  mobileMcpToolsFactory?: (() => MobileMcpTools) | undefined;
}

function runId(): string {
  return `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
}

export function createProductionDependencies(
  signal?: AbortSignal,
  options: ProductionDependencyOptions = {}
): CliDependencies {
  const backendId = resolveRuntimeBackendId(
    options.runtimeBackendChoice ?? readRuntimeBackendChoice(process.env)
  );
  const runner = new NodeProcessRunner();
  let adb: AdbPort;
  let sessions: RuntimeSessionOpener;
  let screenshots: ScreenshotPort;
  let uiStability: UiStabilityProbe;
  let uiSnapshots: UiSnapshotProviderFactory;
  let sharedBackend: SharedSessionRuntimeBackend | undefined;
  if (backendId === "mobile-mcp") {
    const backend = new SharedSessionRuntimeBackend(
      new MobileMcpRuntimeBackend({
        createTools: options.mobileMcpToolsFactory
          ?? ((): MobileMcpTools => new McpToolClient())
      })
    );
    sharedBackend = backend;
    sessions = backend;
    adb = new RuntimeBackendAdbBridge({ backend });
    screenshots = new SessionBackedScreenshotAdapter(backend);
    uiStability = new SessionBackedUiStabilityAdapter(backend);
    uiSnapshots = new CachedUiSnapshotProviderFactory(
      new SessionBackedUiSnapshotProviderFactory(backend)
    );
  } else {
    const adbAdapter = new AdbAdapter(runner);
    const androidCli = new AndroidCliAdapter(runner);
    const autoSnapshots = new CachedUiSnapshotProviderFactory(
      new AutoUiSnapshotProviderFactory(
        new SystemUiAutomatorSnapshotProviderFactory(runner),
        new AndroidCliSnapshotProviderFactory(runner),
        new AppiumUiSnapshotProviderFactory(runner)
      )
    );
    const adbBackend = new AdbRuntimeBackend({
      adb: adbAdapter,
      screenshots: androidCli,
      annotatedScreens: androidCli,
      uiStability: androidCli,
      uiSnapshots: autoSnapshots
    });
    sessions = adbBackend;
    adb = new RuntimeBackendAdbBridge({ backend: adbBackend });
    screenshots = androidCli;
    uiStability = androidCli;
    uiSnapshots = autoSnapshots;
  }
  const clock = new SystemClock();
  const waitUntilIdle = (
    deviceSerial: string,
    config: Parameters<IdleWaiter["waitUntilIdle"]>[0],
    signal?: AbortSignal,
    packageName?: string
  ): ReturnType<IdleWaiter["waitUntilIdle"]> => new IdleWaiter(
    uiStability,
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
  const knowledgeReceiptStore = new FileSystemKnowledgeReceiptStore();
  const knowledgeLoader = new KnowledgeLoader(knowledgeRegistry);
  const knowledgeReceiptRecorder = new KnowledgeReceiptRecorder(
    knowledgeReceiptStore
  );
  const knowledgeBootstrapper = new KnowledgeBootstrapper(knowledgeRegistry);
  const knowledgePromotion = new KnowledgePromotionService({
    registry: knowledgeRegistry,
    receipts: knowledgeReceiptStore
  });
  const knowledgeEvolution = new KnowledgeEvolutionService({
    registry: knowledgeRegistry,
    receipts: knowledgeReceiptStore
  });
  const benchmarkStore = new FileSystemBenchmarkStore();
  return {
    ...(signal === undefined ? {} : { signal }),
    ...(sharedBackend === undefined
      ? {}
      : { close: (): Promise<void> => sharedBackend.close() }),
    doctor: new DoctorService({
      runner,
      adb,
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
      prompt: new InquirerRecorderPrompt(),
      journeyWriter: new FileSystemJourneyWriter()
    }),
    verifier: new VerifyRuntime({
      sessions,
      sessionPorts: runtimeSessionPortViews,
      clock,
      artifactStore: new FileSystemArtifactStore(),
      reportWriter: new ReportWriter(),
      now: () => new Date(),
      createRunId: runId,
      anchorResolverFor: (projectRoot): AnchorResolverPort => (
        new KnowledgeAnchorResolver(knowledgeRegistry, projectRoot)
      )
    }),
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
      adb,
      probe: new CameraProbeAdapter({
        adb,
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
    uiCache: {
      status: async (projectRoot) => new FileSystemUiCacheStore(projectRoot).status(),
      clear: async (projectRoot) => new FileSystemUiCacheStore(projectRoot).clear()
    },
    knowledge: {
      load: (input): Promise<LoadedKnowledgeBundle> => knowledgeLoader.load(input),
      bootstrap: (input): Promise<WriteKnowledgeBundleResult> => (
        knowledgeBootstrapper.bootstrap(input)
      ),
      promote: (input): Promise<WriteKnowledgeBundleResult> => (
        knowledgePromotion.promote(input)
      ),
      evolve: (input): Promise<KnowledgeEvolutionResult> => (
        knowledgeEvolution.evolve(input)
      ),
      listReceipts: (projectRoot): Promise<readonly KnowledgeReceipt[]> => (
        knowledgeReceiptStore.list(projectRoot)
      )
    },
    benchmark: {
      store: benchmarkStore
    },
    generationStarter: {
      start: async (input): Promise<
        Awaited<ReturnType<GenerationStarter["start"]>>
      > => new GenerationStarter({
        contextValidator,
        appPreparer: new GenerationAppPreparer(adb, clock),
        uiSnapshots,
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
          sessions,
          sessionPorts: runtimeSessionPortViews,
          waitUntilIdle,
          now: () => new Date(),
          createAttemptId: randomUUID
        }).observe(input)
      )
    },
    generationRuntime: ({ projectRoot, config }): GenerationCliRuntime => {
      const store = generationStoreFactory(projectRoot);
      const planner = new GenerationPlanner({
        projectRoot,
        knowledge: knowledgeLoader,
        receipts: knowledgeReceiptRecorder,
        now: (): Date => new Date(),
        createReceiptId: randomUUID
      });
      const prompt = new InquirerGenerationPrompt();
      const observer = new RuntimeObserver({
        store,
        sessions,
        sessionPorts: runtimeSessionPortViews,
        waitUntilIdle,
        now: (): Date => new Date(),
        createAttemptId: randomUUID,
        uiCacheEnabled: config.ui?.cacheEnabled ?? true,
        uiSnapshotTimeoutMs: config.ui?.snapshotTimeoutMs,
        planSnapshot: async ({
          session,
          snapshot,
          verifyTransition
        }): Promise<SnapshotPlanning> => {
          const result = await planner.planSnapshot(
            session,
            snapshot,
            verifyTransition
          );
          return { planning: result.planning, timing: result.timing };
        }
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
        anchorResolverFor: (projectRoot): AnchorResolverPort => (
          new KnowledgeAnchorResolver(knowledgeRegistry, projectRoot)
        )
      });
      const finalizer = new GenerationFinalizer({
        store,
        contextValidator,
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
      return {
        confirmation,
        executor,
        observer,
        finalizer,
        recovery,
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
        readContextSnapshot: (id): Promise<ResolvedProjectContext | null> => (
          readGenerationContextSnapshot({ store }, id)
        ),
        assertConfigIdentity: async (id): Promise<void> => {
          const session = await store.read(id);
          if (hashGenerationBinding(config) !== session.bindings.configHash) {
            throw new GenerationOperationError(
              "CONFIG_INVALID",
              "Generation configuration does not match the authoritative session"
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
            appPreparer: new GenerationAppPreparer(adb, clock)
          }).replace(input)
        ),
        resolvePlannedAction: async (input): Promise<ActionResolutionResult> => {
          if (input.session.version !== 2 || input.session.planning === undefined) {
            throw new GenerationOperationError(
              "KNOWLEDGE_INVALID",
              "Generation session has no planning binding"
            );
          }
          const knowledge = await knowledgeLoader.load({
            projectRoot,
            packageName: input.session.target.packageName,
            expectedKnowledgeHash: input.session.planning.knowledgeHash
          });
          return planner.resolveNext({ ...input, knowledge });
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
