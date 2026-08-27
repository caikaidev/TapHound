import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

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
import type { ExternalFlow } from "../../../src/domain/external-flow.js";
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
import type { VerifyInput, VerifyResult } from "../../../src/application/runtime/verify-runtime.js";
import type { CommandResult, RunningCommand } from "../../../src/ports/process-runner.js";
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
const cameraPackage = "com.android.camera";
const cameraActivity = "com.android.camera.CameraActivity";

const ok: CommandResult = {
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  cancelled: false,
  durationMs: 1
};

const triggerElement = {
  id: "camera_btn",
  resourceId: "camera_btn",
  text: "Take Photo",
  enabled: true,
  clickable: true,
  bounds: { left: 10, top: 10, right: 90, bottom: 90 },
  children: []
};

const shutterElement = {
  id: "shutter_button",
  resourceId: "shutter_button",
  text: "Shutter",
  enabled: true,
  clickable: true,
  bounds: { left: 200, top: 800, right: 400, bottom: 1000 },
  children: []
};

const confirmElement = {
  id: "done_button",
  resourceId: "done_button",
  text: "Done",
  enabled: true,
  clickable: true,
  bounds: { left: 300, top: 900, right: 500, bottom: 1100 },
  children: []
};

const topologyMock = {
  version: 1 as const,
  status: "unavailable" as const,
  windows: [],
  diagnostic: "bridge test snapshot"
};

const expectedWindowHierarchy = assessWindowHierarchy(topologyMock, [triggerElement]);

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
    confirmationRequiredActions: [],
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

interface BridgeFixture {
  root: string;
  canonicalRoot: string;
  store: FileSystemGenerationSessionStore;
  starter: GenerationStarter;
  observer: RuntimeObserver;
  executor: GenerationStepExecutor;
  finalizer: GenerationFinalizer;
  verify: Mock<VerifyFunction>;
  externalFlowResolver: {
    resolve: Mock;
  };
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

const cameraFlow: ExternalFlow = {
  version: 1,
  kind: "externalFlow",
  name: "camera-photo",
  description: "Camera photo capture flow",
  escapedPackageName: cameraPackage,
  expectedEscapeActivity: cameraActivity,
  includes: [],
  steps: [
    {
      action: "click",
      locator: { resourceId: "shutter_button" },
      expectedActivity: cameraActivity
    },
    {
      action: "click",
      locator: { resourceId: "done_button" },
      expectedActivity: cameraActivity
    }
  ]
};

const cameraFlowSha256 = "d".repeat(64);

async function createBridgeFixture(): Promise<BridgeFixture> {
  const root = await mkdtemp(join(tmpdir(), "taphound-bridge-"));
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

  let tapCount = 0;
  let escaped = false;
  const adb = {
    foregroundComponent: vi.fn(() => {
      if (escaped) {
        return Promise.resolve({
          packageName: cameraPackage,
          activity: cameraActivity
        });
      }
      return Promise.resolve({ packageName, activity });
    }),
    appProcesses: vi.fn(() =>
      Promise.resolve([{ pid: 42, name: packageName }])
    ),
    windowTopology: vi.fn(() =>
      Promise.resolve(topologyMock)
    ),
    tap: vi.fn(() => {
      tapCount += 1;
      if (tapCount === 1) {
        escaped = true;
      }
      if (tapCount >= 3) {
        escaped = false;
      }
      return Promise.resolve(ok);
    }),
    back: vi.fn(() => Promise.resolve(ok)),
    startLogcat: vi.fn(() => running)
  };

  const androidCli = {
    layout: vi.fn(() => {
      if (escaped) {
        return Promise.resolve([shutterElement, confirmElement]);
      }
      return Promise.resolve([triggerElement]);
    }),
    layoutDiff: vi.fn(() => Promise.resolve([])),
    captureScreen: vi.fn(async (options: { outputPath: string }): Promise<CommandResult> => {
      await writeFile(options.outputPath, Buffer.from("png-evidence"));
      return ok;
    })
  };

  const ids = ["generation-bridge-id", "journey-bridge-run"];
  const starter = new GenerationStarter({
    contextValidator: {
      validate: vi.fn(() => Promise.resolve({ status: "valid" as const }))
    },
    appPreparer: { prepare: vi.fn(() => Promise.resolve()) },
    store,
    now: (): Date => new Date("2026-07-22T12:00:00.000Z"),
    generateId: (): string => ids.shift() ?? "unexpected-id",
    randomBytes: (): Uint8Array => Uint8Array.from([0, 10, 255])
  });

  const attemptIds = ["attempt-1", "attempt-2", "attempt-3"];
  const observer = new RuntimeObserver({
    store,
    adb: adb,
    androidCli: androidCli,
    now: (): Date => new Date("2026-07-22T12:00:01.000Z"),
    createAttemptId: (): string => attemptIds.shift() ?? "unexpected-attempt"
  });

  const externalFlowResolver = {
    resolve: vi.fn(() =>
      Promise.resolve({
        flow: cameraFlow,
        flowSha256: cameraFlowSha256,
        stepCount: cameraFlow.steps.length
      })
    )
  };

  let nowCounter = 100;
  const executor = new GenerationStepExecutor({
    store,
    freshnessGuard: {
      assertFresh: vi.fn(
        async (): Promise<RuntimeSnapshot> => {
          const session = await store.read("generation-bridge-id");
          if (session.bindings.snapshotHash === null) {
            throw new Error("No snapshot hash in session");
          }
          return buildSnapshotFromSession(session);
        }
      )
    },
    adb: adb as never,
    androidCli: androidCli as never,
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
    externalFlowResolver,
    clearApprovedConfirmation: (): Promise<void> => Promise.resolve(),
    observeNext: async (input): Promise<RuntimeObservation> =>
      observer.observeCollected({
        generationId: input.generationId,
        runtime: input.runtime,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      })
  });

  const verify = vi.fn<VerifyFunction>(async () => {
    const session = await store.read("generation-bridge-id");
    const journey: Journey = {
      version: 1,
      name: "generated",
      steps: session.candidateSteps
    };
    return {
      status: "passed" as const,
      exitCode: 0 as const,
      report: buildBridgePassingReport(canonicalRoot, journey, session.candidateSteps),
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
    executor,
    finalizer,
    verify,
    externalFlowResolver,
    adb,
    androidCli
  };
}

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
    layout: [triggerElement],
    windowHierarchy: expectedWindowHierarchy
  };
}

function buildBridgePassingReport(
  root: string,
  journey: Journey,
  candidateSteps: readonly JourneyStep[]
): TapHoundReport {
  return {
    schemaVersion: 2,
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
      tools: { adb: "1" }
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
      const isBridge = candidate.action === "bridge";
      return {
        index,
        action: candidate.action,
        status: "passed" as const,
        ...(isBridge ? { replayMode: "auto" as const } : {}),
        startedAtMs: index * 10,
        finishedAtMs: index * 10 + 1,
        durationMs: 1,
        ...(hasLocator
          ? {
              locator: {
                status: "found" as const,
                matchedBy: "resourceId" as const,
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

function makeBridgeProposal(
  generationId: string,
  snapshot: RuntimeSnapshot
): ProposedStep {
  return {
    action: "bridge",
    scenario: "custom",
    description: "Open camera to take a photo",
    triggerLocator: { resourceId: "camera_btn" },
    flow: "camera-photo",
    returnTimeoutMs: 10_000,
    binding: {
      generationId,
      baseRevision: snapshot.baseRevision,
      snapshotHash: hashRuntimeSnapshot(snapshot)
    },
    activity: { before: activity }
  };
}

describe("Bridge External Flow lifecycle regression", () => {
  it("executes start → observe → bridge(--flow) → finalize(auto) with external flow resolution", async () => {
    const test = await createBridgeFixture();

    // 1. Start with external flow binding
    const session = await test.starter.start({
      projectRoot: test.canonicalRoot,
      config,
      context,
      project: projectDescription(test.canonicalRoot),
      deviceSerial,
      externalFlows: [{
        name: "camera-photo",
        flowSha256: cameraFlowSha256,
        escapedPackageName: cameraPackage,
        stepCount: cameraFlow.steps.length
      }]
    });

    expect(session.revision).toBe(0);
    expect(session.externalFlows).toHaveLength(1);
    expect(session.externalFlows[0]?.name).toBe("camera-photo");
    expect(session.externalFlows[0]?.flowSha256).toBe(cameraFlowSha256);

    // 2. Observe: commits snapshot, bumps to revision 1
    const observation: RuntimeObservation = await test.observer.observe({
      generationId: session.id
    });

    expect(observation.binding.baseRevision).toBe(1);
    expect(observation.snapshot.activity).toBe(activity);

    // 3. Bridge step with --flow: trigger click → escape detection → flow resolution → external steps → return wait → idle
    const bridgeProposal = makeBridgeProposal(session.id, observation.snapshot);

    const stepResult = await test.executor.execute({
      generationId: session.id,
      proposal: bridgeProposal,
      snapshot: observation.snapshot,
      source: "manualOverride"
    });

    expect(stepResult.status).toBe("succeeded");
    if (stepResult.status !== "succeeded") return;
    expect(stepResult.step.action).toBe("bridge");
    if (stepResult.step.action !== "bridge") return;
    expect(stepResult.step.replayMode).toBe("auto");
    expect(stepResult.step.escapedPackageName).toBe(cameraPackage);
    expect(stepResult.step.externalSteps).toBeDefined();
    if (stepResult.step.externalSteps === undefined) return;
    expect(stepResult.step.externalSteps).toHaveLength(2);
    const shutterStep = stepResult.step.externalSteps[0];
    expect(shutterStep?.action).toBe("click");
    if (shutterStep && shutterStep.action === "click") {
      expect(shutterStep.locator.resourceId).toBe("shutter_button");
    }
    const confirmStep = stepResult.step.externalSteps[1];
    expect(confirmStep?.action).toBe("click");
    if (confirmStep && confirmStep.action === "click") {
      expect(confirmStep.locator.resourceId).toBe("done_button");
    }

    expect(test.externalFlowResolver.resolve).toHaveBeenCalledTimes(1);
    expect(test.externalFlowResolver.resolve.mock.calls[0]?.[0]).toEqual({
      projectRoot: test.canonicalRoot,
      name: "camera-photo"
    });

    const afterStep = await test.store.read(session.id);
    expect(afterStep.candidateSteps).toHaveLength(1);
    expect(afterStep.candidateSteps[0]?.action).toBe("bridge");
    if (afterStep.candidateSteps[0]?.action !== "bridge") return;
    expect(afterStep.candidateSteps[0].replayMode).toBe("auto");

    // 4. Finalize with manualReplay: false (non-interactive) — should succeed because replayMode is "auto"
    const finalizeResult = await test.finalizer.finalize({
      generationId: session.id,
      projectRoot: test.canonicalRoot,
      config,
      context,
      project: projectDescription(test.canonicalRoot),
      outputPath: ".taphound/journeys/generated.json",
      deviceSerial,
      toolVersions: { adb: "1" },
      manualReplay: false
    });

    expect(finalizeResult.status).toBe("verified");

    // Verify published journey exists
    const journeyText = await readFile(
      join(test.root, ".taphound/journeys/generated.json"),
      "utf8"
    );
    const publishedJourney = JSON.parse(journeyText) as Journey;
    const firstStep = publishedJourney.steps[0];
    expect(firstStep?.action).toBe("bridge");
    if (firstStep && firstStep.action === "bridge") {
      expect(firstStep.replayMode).toBe("auto");
    }

    // Verify manifest
    const manifestText = await readFile(
      join(test.root, ".taphound/build/generations/generation-bridge-id/manifest.json"),
      "utf8"
    );
    const manifest = JSON.parse(manifestText) as { files: { path: string }[] };
    expect(manifest.files.map((f) => f.path)).toContain("verified/journey.json");
  });

  it("rejects finalize with manualReplay:false when bridge step has replayMode manual", async () => {
    const test = await createBridgeFixture();

    const session = await test.starter.start({
      projectRoot: test.canonicalRoot,
      config,
      context,
      project: projectDescription(test.canonicalRoot),
      deviceSerial,
      externalFlows: [{
        name: "camera-photo",
        flowSha256: cameraFlowSha256,
        escapedPackageName: cameraPackage,
        stepCount: cameraFlow.steps.length
      }]
    });

    const observation = await test.observer.observe({
      generationId: session.id
    });

    const bridgeProposal = makeBridgeProposal(session.id, observation.snapshot);
    const stepResult = await test.executor.execute({
      generationId: session.id,
      proposal: bridgeProposal,
      snapshot: observation.snapshot,
      source: "manualOverride"
    });
    expect(stepResult.status).toBe("succeeded");

    // Manually rewrite candidate step to have replayMode "manual"
    const current = await test.store.read(session.id);
    const manualSteps = current.candidateSteps.map((step) => {
      if (step.action === "bridge") {
        return { ...step, replayMode: "manual" as const, externalSteps: undefined, flow: undefined };
      }
      return step;
    });
    await test.store.update(session.id, current.revision, {
      ...current,
      revision: current.revision + 1,
      candidateSteps: manualSteps
    });

    // Override verify to return a report matching the manual bridge step
    test.verify.mockResolvedValueOnce({
      status: "passed",
      exitCode: 0,
      report: buildBridgePassingReport(
        test.canonicalRoot,
        { version: 1, name: "generated", steps: manualSteps },
        manualSteps
      ),
      reportPath: "/reports/report.json",
      summaryPath: "/reports/summary.txt"
    });

    await expect(
      test.finalizer.finalize({
        generationId: session.id,
        projectRoot: test.canonicalRoot,
        config,
        context,
        project: projectDescription(test.canonicalRoot),
        outputPath: ".taphound/journeys/generated.json",
        deviceSerial,
        toolVersions: { adb: "1" },
        manualReplay: false
      })
    ).rejects.toThrow(/manual steps/);
  });

  it("rejects bridge step when external flow is not bound to session", async () => {
    const test = await createBridgeFixture();

    // Start WITHOUT external flow binding
    const session = await test.starter.start({
      projectRoot: test.canonicalRoot,
      config,
      context,
      project: projectDescription(test.canonicalRoot),
      deviceSerial
    });

    expect(session.externalFlows).toEqual([]);

    const observation = await test.observer.observe({
      generationId: session.id
    });

    const bridgeProposal = makeBridgeProposal(session.id, observation.snapshot);
    const stepResult = await test.executor.execute({
      generationId: session.id,
      proposal: bridgeProposal,
      snapshot: observation.snapshot,
      source: "manualOverride"
    });

    expect(stepResult.status).toBe("failed");
    if (stepResult.status !== "failed") return;
    expect(stepResult.failure.code).toBe("EXTERNAL_FLOW_NOT_FOUND");
  });

  it("rejects bridge step when external flow sha256 has drifted", async () => {
    const test = await createBridgeFixture();

    const session = await test.starter.start({
      projectRoot: test.canonicalRoot,
      config,
      context,
      project: projectDescription(test.canonicalRoot),
      deviceSerial,
      externalFlows: [{
        name: "camera-photo",
        flowSha256: "e".repeat(64),
        escapedPackageName: cameraPackage,
        stepCount: cameraFlow.steps.length
      }]
    });

    const observation = await test.observer.observe({
      generationId: session.id
    });

    const bridgeProposal = makeBridgeProposal(session.id, observation.snapshot);
    const stepResult = await test.executor.execute({
      generationId: session.id,
      proposal: bridgeProposal,
      snapshot: observation.snapshot,
      source: "manualOverride"
    });

    expect(stepResult.status).toBe("failed");
    if (stepResult.status !== "failed") return;
    expect(stepResult.failure.code).toBe("EXTERNAL_FLOW_STALE");
  });
});
