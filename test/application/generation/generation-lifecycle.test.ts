import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  uiSnapshotFactory,
  uiSnapshotProviderFromLayout
} from "../../fakes/ui-snapshot.js";

import {
  FileSystemGenerationMetaWriter
} from "../../../src/adapters/filesystem/generation-meta-writer.js";
import {
  FileSystemGenerationSessionStore
} from "../../../src/adapters/filesystem/generation-session-store.js";
import {
  FileSystemJourneyWriter
} from "../../../src/adapters/filesystem/journey-writer.js";
import {
  GenerationConfirmationService
} from "../../../src/application/generation/generation-confirmation-service.js";
import {
  GenerationFinalizer
} from "../../../src/application/generation/generation-finalizer.js";
import {
  GenerationPublisher
} from "../../../src/application/generation/generation-publisher.js";
import {
  GenerationStarter
} from "../../../src/application/generation/generation-starter.js";
import {
  GenerationStepExecutor
} from "../../../src/application/generation/generation-step-executor.js";
import {
  RuntimeObserver,
  type RuntimeObservation
} from "../../../src/application/generation/runtime-observer.js";
import type { TapHoundConfig } from "../../../src/domain/config.js";
import type { GenerationSession } from "../../../src/domain/generation.js";
import type { Journey, JourneyStep } from "../../../src/domain/journey.js";
import type { ProposedStep } from "../../../src/domain/proposed-step.js";
import type { ResolvedProjectContext } from "../../../src/domain/project-context.js";
import {
  hashRuntimeSnapshot,
  type RuntimeSnapshot
} from "../../../src/domain/runtime-snapshot.js";
import { hashJourney, type TapHoundReport } from "../../../src/domain/report.js";
import { assessWindowHierarchy } from "../../../src/domain/window-hierarchy.js";
import type { CommandResult, RunningCommand } from "../../../src/ports/process-runner.js";
import type { VerifyInput, VerifyResult } from "../../../src/application/runtime/verify-runtime.js";
import { contextSelection } from "../../fixtures/project-context.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const activity = "com.example.app.MainActivity";
const deviceSerial = "emulator-5554";
const packageName = "com.example.app";

const ok: CommandResult = {
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  cancelled: false,
  durationMs: 1
};

const layoutElement = {
  id: "continue_btn",
  resourceId: "continue_btn",
  text: "Continue run-42",
  enabled: true,
  clickable: true,
  bounds: { left: 0, top: 0, right: 100, bottom: 100 },
  children: []
};

const config: TapHoundConfig = {
  version: 1,
  run: { packageName, activity: ".MainActivity" },
  idle: {
    strategy: "hybrid",
    pollIntervalMs: 1,
    stablePolls: 1,
    timeoutMs: 10
  },
  artifactsDir: ".taphound/build/reports"
};

const context: ResolvedProjectContext = {
  version: 2,
  packageName,
  launchActivity: `${packageName}.MainActivity`,
  manifest: {
    version: 1,
    files: [{
      path: "app/src/main/AndroidManifest.xml",
      sha256: "a".repeat(64),
      confidence: "sourceConfirmed"
    }]
  },
  interactionPolicy: {
    allowedActions: ["click", "inputText", "scrollTo", "back"],
    confirmationRequiredActions: ["back"],
    forbiddenActions: ["longClick"]
  },
  selection: contextSelection
};

function projectDescription(root: string): { projectRoot: string; packageName: string; launchActivity: string } {
  return {
    projectRoot: root,
    packageName,
    launchActivity: `${packageName}.MainActivity`
  };
}

type VerifyFunction = (input: VerifyInput) => Promise<VerifyResult>;

interface LifecycleFixture {
  root: string;
  canonicalRoot: string;
  store: FileSystemGenerationSessionStore;
  starter: GenerationStarter;
  observer: RuntimeObserver;
  confirmation: GenerationConfirmationService;
  executor: GenerationStepExecutor;
  finalizer: GenerationFinalizer;
  verify: Mock<VerifyFunction>;
  adb: {
    foregroundComponent: Mock;
    appProcesses: Mock;
    windowTopology: Mock;
    tap: Mock;
    back: Mock;
    startLogcat: Mock;
  };
  androidCli: {
    layout: Mock;
    layoutDiff: Mock;
    captureScreen: Mock;
  };
}

async function createLifecycleFixture(): Promise<LifecycleFixture> {
  const root = await mkdtemp(join(tmpdir(), "taphound-lifecycle-"));
  const canonicalRoot = await realpath(root);
  roots.push(root);

  const store = new FileSystemGenerationSessionStore(root, {
    now: (): Date => new Date("2026-07-22T12:00:03.000Z")
  });

  const stopLogcat = vi.fn((): Promise<CommandResult> => Promise.resolve(ok));
  const running: RunningCommand = {
    started: Promise.resolve(undefined),
    completion: Promise.resolve(ok),
    stop: stopLogcat
  };

  const adb = {
    foregroundComponent: vi.fn(() =>
      Promise.resolve({ packageName, activity })
    ),
    appProcesses: vi.fn(() =>
      Promise.resolve([{ pid: 42, name: packageName }])
    ),
    windowTopology: vi.fn(() =>
      Promise.resolve(topologyMock)
    ),
    tap: vi.fn(() => Promise.resolve(ok)),
    back: vi.fn(() => Promise.resolve(ok)),
    startLogcat: vi.fn(() => running)
  };

  const androidCli = {
    layout: vi.fn(() => Promise.resolve([layoutElement])),
    layoutDiff: vi.fn(() => Promise.resolve([])),
    captureScreen: vi.fn(async (options: { outputPath: string }): Promise<CommandResult> => {
      await writeFile(options.outputPath, Buffer.from("png-evidence"));
      return ok;
    })
  };

  const ids = ["generation-core-id", "journey-run-id"];
  const starter = new GenerationStarter({
    contextValidator: {
      validate: vi.fn(() => Promise.resolve({ status: "valid" as const }))
    },
    appPreparer: { prepare: vi.fn(() => Promise.resolve()) },
    uiSnapshots: uiSnapshotFactory(
      uiSnapshotProviderFromLayout(androidCli.layout)
    ),
    store,
    now: (): Date => new Date("2026-07-22T12:00:00.000Z"),
    generateId: (): string => ids.shift() ?? "unexpected-id",
    randomBytes: (): Uint8Array => Uint8Array.from([0, 10, 255])
  });

  const attemptIds = ["attempt-1", "attempt-2", "attempt-3", "attempt-4"];
  const observer = new RuntimeObserver({
    store,
    adb: adb,
    screenshots: { capture: androidCli.captureScreen },
    uiSnapshots: uiSnapshotFactory(
      uiSnapshotProviderFromLayout(androidCli.layout)
    ),
    now: (): Date => new Date("2026-07-22T12:00:01.000Z"),
    createAttemptId: (): string => attemptIds.shift() ?? "unexpected-attempt"
  });

  const confirmation = new GenerationConfirmationService({
    store,
    prompt: {
      confirm: vi.fn(() => Promise.resolve(true)),
      buildManualProposal: vi.fn()
    },
    now: (): Date => new Date("2026-07-22T12:00:02.000Z"),
    generateChallengeId: (): string => "challenge-1",
    confirmationTtlMs: 30_000
  });

  let nowCounter = 100;
  const executor = new GenerationStepExecutor({
    store,
    freshnessGuard: {
      assertFresh: vi.fn(
        async (): Promise<RuntimeSnapshot> => {
          const session = await store.read("generation-core-id");
          if (session.bindings.snapshotHash === null) {
            throw new Error("No snapshot hash in session");
          }
          return buildSnapshotFromSession(session);
        }
      )
    },
    adb: adb as never,
    uiStability: {
      reset: vi.fn(),
      sample: androidCli.layoutDiff
    },
    uiSnapshotProvider: uiSnapshotProviderFromLayout(androidCli.layout),
    clock: {
      now: (): number => {
        nowCounter += 1;
        return nowCounter;
      },
      sleep: (): Promise<void> => Promise.resolve()
    },
    idle: { pollIntervalMs: 1, stablePolls: 1, timeoutMs: 10 },
    now: (): Date => new Date("2026-07-22T12:00:03.000Z"),
    generateAttemptId: (): string => "step-attempt",
    projectRoot: canonicalRoot,
    clearApprovedConfirmation: async (generationId, challenge): Promise<void> => {
      await confirmation.clearApproved({ generationId, challenge });
    },
    observeNext: async (input): Promise<RuntimeObservation> =>
      observer.observeCollected({
        generationId: input.generationId,
        runtime: input.runtime,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      })
  });

  const verify = vi.fn<VerifyFunction>(async () => {
    const session = await store.read("generation-core-id");
    const journey: Journey = {
      version: 1,
      name: "generated",
      steps: session.candidateSteps
    };
    return {
      status: "passed" as const,
      exitCode: 0 as const,
      report: buildPassingReport(canonicalRoot, journey, session.candidateSteps),
      reportPath: "/reports/report.json",
      summaryPath: "/reports/summary.txt"
    };
  });

  const publisher = new GenerationPublisher({
    store,
    journeyWriter: new FileSystemJourneyWriter(),
    metaWriter: new FileSystemGenerationMetaWriter()
  });

  const finalizer = new GenerationFinalizer({
    store,
    contextValidator: {
      validate: vi.fn(() => Promise.resolve({ status: "valid" as const }))
    },
    verifyRuntime: { verify },
    publisher,
    generateAttemptId: (): string => "verification-attempt"
  });

  return {
    root,
    canonicalRoot,
    store,
    starter,
    observer,
    confirmation,
    executor,
    finalizer,
    verify,
    adb,
    androidCli
  };
}

const topologyMock = {
  version: 1 as const,
  status: "unavailable" as const,
  windows: [],
  diagnostic: "legacy test snapshot"
};

const expectedWindowHierarchy = assessWindowHierarchy(topologyMock, [layoutElement]);

function buildSnapshotFromSession(session: GenerationSession): RuntimeSnapshot {
  return {
    version: 1,
    generationId: session.id,
    baseRevision: session.revision,
    deviceSerial: session.target.deviceSerial,
    expectedPackageName: session.target.packageName,
    foregroundPackageName: packageName,
    activity,
    pid: 42,
    capturedAt: "2026-07-22T12:00:01.000Z",
    layout: [layoutElement],
    windowHierarchy: expectedWindowHierarchy
  };
}

function buildPassingReport(
  root: string,
  journey: Journey,
  candidateSteps: readonly JourneyStep[]
): TapHoundReport {
  return {
    schemaVersion: 3,
    runId: "verify-run",
    status: "passed",
    startedAt: "2026-07-23T00:00:00.000Z",
    finishedAt: "2026-07-23T00:00:01.000Z",
    durationMs: 1_000,
    project: {
      root,
      packageName,
      launchActivity: `${packageName}.MainActivity`
    },
    journey: { name: journey.name, sha256: hashJourney(journey) },
    environment: {
      deviceSerial,
      tools: { adb: "1" },
      uiBackend: {
        id: "system-uiautomator",
        adapterVersion: "test-v1",
        configSha256: "0".repeat(64)
      }
    },
    layers: {
      run: "passed",
      structural: "passed",
      activityCheckpoint: "passed",
      explicitExpect: "passed",
      collection: "passed"
    },
    steps: candidateSteps.map((candidate, index) => {
      const hasLocator = candidate.action === "click"
        || candidate.action === "longClick"
        || candidate.action === "swipe"
        || candidate.action === "bridge";
      return {
        index,
        action: candidate.action,
        status: "passed" as const,
        startedAtMs: index * 10,
        finishedAtMs: index * 10 + 1,
        durationMs: 1,
        ...(hasLocator
          ? {
              locator: {
                status: "found" as const,
                matchedBy: "text" as const,
                fallbackUsed: false
              }
            }
          : {}),
        idle: {
          status: "stable" as const,
          polls: 1
        },
        activity: {
          before: {
            status: "passed" as const,
            expected: candidate.activity.before,
            actual: candidate.activity.before
          },
          after: {
            status: "passed" as const,
            expected: candidate.activity.after,
            actual: candidate.activity.after
          }
        }
      };
    }),
    artifacts: {
      directory: "/reports/verify-run",
      report: "report.json",
      summary: "summary.txt",
      stepLogs: []
    },
    secondaryErrors: [],
    fallbackUsed: false
  };
}

function makeClickProposal(
  generationId: string,
  snapshot: RuntimeSnapshot
): ProposedStep {
  return {
    action: "click",
    locator: { text: "Continue run-42" },
    binding: {
      generationId,
      baseRevision: snapshot.baseRevision,
      snapshotHash: hashRuntimeSnapshot(snapshot)
    },
    activity: { before: activity }
  };
}

function makeBackProposal(
  generationId: string,
  snapshot: RuntimeSnapshot
): ProposedStep {
  return {
    action: "back",
    binding: {
      generationId,
      baseRevision: snapshot.baseRevision,
      snapshotHash: hashRuntimeSnapshot(snapshot)
    },
    activity: { before: activity }
  };
}

describe("Generation lifecycle regression", () => {
  it("executes start → observe → click → back+confirmation → click → finalize with consistent revisions", async () => {
    const test = await createLifecycleFixture();

    // 1. Start: creates session at revision 0
    const session = await test.starter.start({
      projectRoot: test.canonicalRoot,
      config,
      context,
      project: projectDescription(test.canonicalRoot),
      deviceSerial
    });

    expect(session.revision).toBe(0);
    expect(session.bindings.snapshotHash).toBeNull();
    expect(session.state).toBe("active");
    expect(session.candidateSteps).toEqual([]);

    // 2. Observe: commits snapshot, bumps to revision 1
    const observation: RuntimeObservation = await test.observer.observe({
      generationId: session.id
    });

    expect(observation.binding.baseRevision).toBe(1);
    expect(observation.snapshotHash).toMatch(/^[a-f\d]{64}$/);
    expect(observation.snapshot.activity).toBe(activity);
    expect(observation.snapshot.pid).toBe(42);

    const stored = await test.store.read(session.id);
    expect(stored.revision).toBe(1);
    expect(stored.bindings.snapshotHash).toBe(observation.snapshotHash);

    // 3. Step 1 (click, safe): beginStep 1→2, completeStep 2→3, observeNext 3→4
    let currentSnapshot = observation.snapshot;
    const clickProposal1 = makeClickProposal(session.id, currentSnapshot);

    const step1Result = await test.executor.execute({
      generationId: session.id,
      proposal: clickProposal1,
      snapshot: currentSnapshot,
      source: "manualOverride"
    });

    expect(step1Result.status).toBe("succeeded");
    if (step1Result.status !== "succeeded") return;
    expect(step1Result.step.action).toBe("click");
    expect(step1Result.step.activity).toEqual({
      before: activity,
      after: activity
    });
    expect(step1Result.nextObservation).toBeDefined();
    if (step1Result.nextObservation === undefined) return;
    expect(step1Result.nextObservation.binding.baseRevision).toBe(4);

    currentSnapshot = step1Result.nextObservation.snapshot;

    const afterStep1 = await test.store.read(session.id);
    expect(afterStep1.revision).toBe(4);
    expect(afterStep1.candidateSteps).toHaveLength(1);
    expect(afterStep1.candidateSources).toEqual(["manualOverride"]);
    expect(afterStep1.inFlight).toBeNull();
    expect(afterStep1.pendingConfirmation).toBeNull();

    // 4. Step 2 (back, confirmationRequired):
    //    confirmation.request 4→5, confirmation.confirm 5→6,
    //    executor beginStep 6→7, completeStep 7→8, observeNext 8→9
    const backProposal = makeBackProposal(session.id, currentSnapshot);

    const requestResult = await test.confirmation.request({
      generationId: session.id,
      proposal: backProposal,
      snapshot: currentSnapshot,
      source: "manualOverride"
    });

    expect(requestResult.status).toBe("confirmationRequired");
    if (requestResult.status !== "confirmationRequired") return;
    expect(requestResult.challenge.status).toBe("pending");
    expect(requestResult.challenge.actionSummary).toContain("Back");

    const afterRequest = await test.store.read(session.id);
    expect(afterRequest.revision).toBe(5);
    expect(afterRequest.pendingConfirmation).not.toBeNull();
    expect(afterRequest.pendingConfirmation?.status).toBe("pending");

    const confirmResult = await test.confirmation.confirm({
      generationId: session.id,
      proposal: backProposal,
      snapshot: currentSnapshot,
      source: "manualOverride",
      challengeId: requestResult.challenge.challengeId,
      decision: "approve"
    });

    expect(confirmResult.status).toBe("approved");

    const afterConfirm = await test.store.read(session.id);
    expect(afterConfirm.revision).toBe(6);
    expect(afterConfirm.pendingConfirmation?.status).toBe("approved");
    expect(afterConfirm.pendingConfirmation?.approvalMode).toBe("delegated");

    const step2Result = await test.executor.execute({
      generationId: session.id,
      proposal: backProposal,
      snapshot: currentSnapshot,
      source: "manualOverride"
    });

    expect(step2Result.status).toBe("succeeded");
    if (step2Result.status !== "succeeded") return;
    expect(step2Result.step.action).toBe("back");
    expect(step2Result.nextObservation).toBeDefined();
    if (step2Result.nextObservation === undefined) return;
    expect(step2Result.nextObservation.binding.baseRevision).toBe(9);

    currentSnapshot = step2Result.nextObservation.snapshot;

    const afterStep2 = await test.store.read(session.id);
    expect(afterStep2.revision).toBe(9);
    expect(afterStep2.candidateSteps).toHaveLength(2);
    expect(afterStep2.pendingConfirmation).toBeNull();

    // 5. Step 3 (click, safe, post-confirmation):
    //    beginStep 9→10, completeStep 10→11, observeNext 11→12
    const clickProposal3 = makeClickProposal(session.id, currentSnapshot);

    const step3Result = await test.executor.execute({
      generationId: session.id,
      proposal: clickProposal3,
      snapshot: currentSnapshot,
      source: "manualOverride"
    });

    expect(step3Result.status).toBe("succeeded");
    if (step3Result.status !== "succeeded") return;
    expect(step3Result.nextObservation).toBeDefined();
    if (step3Result.nextObservation === undefined) return;
    expect(step3Result.nextObservation.binding.baseRevision).toBe(12);

    const afterStep3 = await test.store.read(session.id);
    expect(afterStep3.revision).toBe(12);
    expect(afterStep3.candidateSteps).toHaveLength(3);

    // 6. Finalize: beginVerification 12→13, completeVerification 13→14,
    //    markBundlePublishable 14→15
    const finalizeResult = await test.finalizer.finalize({
      generationId: session.id,
      projectRoot: test.canonicalRoot,
      config,
      context,
      project: projectDescription(test.canonicalRoot),
      outputPath: ".taphound/journeys/generated.json",
      deviceSerial,
      toolVersions: { adb: "1" }
    });

    expect(finalizeResult.status).toBe("verified");
    expect(finalizeResult.journey.name).toBe("generated");
    expect(finalizeResult.journey.steps).toHaveLength(3);
    expect(test.verify).toHaveBeenCalledOnce();

    const finalized = await test.store.read(session.id);
    expect(finalized.verification.status).toBe("passed");
    expect(finalized.publication.status).toBe("published");
    expect(finalized.revision).toBe(15);

    // Verify published journey file
    const journeyText = await readFile(
      join(test.root, ".taphound/journeys/generated.json"),
      "utf8"
    );
    const publishedJourney = JSON.parse(journeyText) as Journey;
    expect(publishedJourney.steps).toHaveLength(3);
    expect(publishedJourney.steps[0]?.action).toBe("click");
    expect(publishedJourney.steps[1]?.action).toBe("back");
    expect(publishedJourney.steps[2]?.action).toBe("click");

    // Verify published meta file
    const metaText = await readFile(
      join(test.root, ".taphound/journeys/generated.meta.json"),
      "utf8"
    );
    const meta = JSON.parse(metaText) as { status: string };
    expect(meta.status).toBe("verified");

    // Verify manifest in generation bundle
    const manifestText = await readFile(
      join(test.root, ".taphound/build/generations/generation-core-id/manifest.json"),
      "utf8"
    );
    const manifest = JSON.parse(manifestText) as { files: { path: string }[] };
    expect(manifest.files.map((f) => f.path)).toContain("verified/journey.json");
    expect(manifest.files.map((f) => f.path)).toContain("verification/report.json");
  });

  it("rejects finalize when verification report has fallbackUsed", async () => {
    const test = await createLifecycleFixture();

    await test.starter.start({
      projectRoot: test.canonicalRoot,
      config,
      context,
      project: projectDescription(test.canonicalRoot),
      deviceSerial
    });

    const observation = await test.observer.observe({
      generationId: "generation-core-id"
    });

    const clickProposal = makeClickProposal("generation-core-id", observation.snapshot);
    const stepResult = await test.executor.execute({
      generationId: "generation-core-id",
      proposal: clickProposal,
      snapshot: observation.snapshot,
      source: "manualOverride"
    });
    if (stepResult.status !== "succeeded" || stepResult.nextObservation === undefined) {
      throw new Error("step failed");
    }

    // Override verify to return a fallback report
    test.verify.mockResolvedValueOnce({
      status: "passed",
      exitCode: 0,
      report: {
        ...buildPassingReport(
          test.canonicalRoot,
          {
            version: 1,
            name: "generated",
            steps: (await test.store.read("generation-core-id")).candidateSteps
          },
          (await test.store.read("generation-core-id")).candidateSteps
        ),
        fallbackUsed: true
      },
      reportPath: "/reports/report.json",
      summaryPath: "/reports/summary.txt"
    });

    await expect(test.finalizer.finalize({
      generationId: "generation-core-id",
      projectRoot: test.canonicalRoot,
      config,
      context,
      project: projectDescription(test.canonicalRoot),
      outputPath: ".taphound/journeys/generated.json",
      deviceSerial,
      toolVersions: { adb: "1" }
    })).rejects.toBeDefined();
  });

  it("rejects step execution when proposal snapshot hash does not match session", async () => {
    const test = await createLifecycleFixture();

    await test.starter.start({
      projectRoot: test.canonicalRoot,
      config,
      context,
      project: projectDescription(test.canonicalRoot),
      deviceSerial
    });

    await test.observer.observe({
      generationId: "generation-core-id"
    });

    const staleSnapshot: RuntimeSnapshot = {
      version: 1,
      generationId: "generation-core-id",
      baseRevision: 99,
      deviceSerial,
      expectedPackageName: packageName,
      foregroundPackageName: packageName,
      activity,
      pid: 42,
      capturedAt: "2026-07-22T12:00:01.000Z",
      layout: [layoutElement]
    };

    const staleProposal: ProposedStep = {
      action: "click",
    locator: { text: "Continue run-42" },
      binding: {
        generationId: "generation-core-id",
        baseRevision: 99,
        snapshotHash: hashRuntimeSnapshot(staleSnapshot)
      },
      activity: { before: activity }
    };

    await expect(test.executor.execute({
      generationId: "generation-core-id",
      proposal: staleProposal,
      snapshot: staleSnapshot,
      source: "manualOverride"
    })).rejects.toBeDefined();
  });
});
