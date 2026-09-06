import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FileSystemGenerationSessionStore
} from "../../../src/adapters/filesystem/generation-session-store.js";
import {
  GenerationReplaceService
} from "../../../src/application/generation/generation-replace-service.js";
import type {
  GenerationAppPreparationInput
} from "../../../src/application/generation/generation-app-preparer.js";
import type {
  RuntimeObservation,
  RuntimeObserveInput
} from "../../../src/application/generation/runtime-observer.js";
import type {
  VerifyInput,
  VerifyResult
} from "../../../src/application/runtime/verify-runtime.js";
import type { TapHoundConfig } from "../../../src/domain/config.js";
import type { GenerationSession } from "../../../src/domain/generation.js";
import { resolvedProjectContext } from "../../fixtures/project-context.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true
  })));
});

const config: TapHoundConfig = {
  version: 1,
  run: {
    packageName: "com.example.app",
    activity: ".MainActivity"
  },
  idle: {
    strategy: "hybrid",
    pollIntervalMs: 500,
    stablePolls: 3,
    timeoutMs: 10000
  },
  artifactsDir: ".taphound/build/runs"
};

const sessionIdlePolicy = {
  strategy: "structural" as const,
  pollIntervalMs: 250,
  stablePolls: 4,
  timeoutMs: 20000
};

type VerifyFunction = (input: VerifyInput) => Promise<VerifyResult>;
type ObserveFunction = (input: RuntimeObserveInput) => Promise<RuntimeObservation>;
type PrepareFunction = (input: GenerationAppPreparationInput) => Promise<void>;

const waitStep = (
  index: number
): GenerationSession["candidateSteps"][number] => ({
  action: "wait" as const,
  activity: {
    before: `com.example.app.Screen${String(index)}`,
    after: `com.example.app.Screen${String(index)}`
  }
});

function observation(revision: number): RuntimeObservation {
  return {
    binding: {
      generationId: "generation-1",
      baseRevision: revision,
      snapshotHash: "d".repeat(64)
    },
    snapshot: {
      version: 1,
      generationId: "generation-1",
      baseRevision: revision,
      deviceSerial: "emulator-5554",
      expectedPackageName: "com.example.app",
      foregroundPackageName: "com.example.app",
      activity: "com.example.app.MainActivity",
      pid: 42,
      capturedAt: "2026-07-23T00:00:00.000Z",
      layout: []
    },
    snapshotHash: "d".repeat(64),
    snapshotRef: "evidence://generation-1/snapshots/rev-4.json"
  };
}

function session(overrides?: {
  state?: GenerationSession["state"];
  inFlight?: GenerationSession["inFlight"];
  pendingConfirmation?: GenerationSession["pendingConfirmation"];
  verification?: GenerationSession["verification"];
  publication?: GenerationSession["publication"];
  idlePolicy?: GenerationSession["idlePolicy"];
  stepCount?: number;
  baseFlow?: GenerationSession["baseFlow"];
  flowStepCount?: number;
}): GenerationSession {
  const stepCount = overrides?.stepCount ?? 3;
  const flowStepCount = overrides?.flowStepCount ?? 0;
  return {
    version: 1,
    id: "generation-1",
    revision: 0,
    state: overrides?.state ?? "active",
    bindings: {
      projectHash: "0".repeat(64),
      configHash: "1".repeat(64),
      contextHash: "2".repeat(64),
      snapshotHash: "c".repeat(64),
      uiBackend: {
        id: "system-uiautomator",
        adapterVersion: "1.0.0",
        configSha256: "3".repeat(64)
      }
    },
    target: {
      packageName: "com.example.app",
      deviceSerial: "emulator-5554",
      resetStrategy: "processOnly",
      interactionPolicy: resolvedProjectContext.interactionPolicy
    },
    contextSelection: resolvedProjectContext.selection,
    ...(overrides?.idlePolicy === undefined
      ? {}
      : { idlePolicy: overrides.idlePolicy }),
    variables: {
      runId: "candidate-run",
      timestamp: "2026-07-23T00:00:00.000Z",
      randomHex: "c0ffee"
    },
    ...(overrides?.baseFlow === undefined ? {} : { baseFlow: overrides.baseFlow }),
    candidateSteps: Array.from({ length: stepCount }, (_unused, index) => (
      waitStep(index)
    )),
    candidateSources: Array.from({ length: stepCount }, (_unused, index) => (
      index < flowStepCount ? "flow" as const : "planner" as const
    )),
    inFlight: overrides?.inFlight ?? null,
    pendingConfirmation: overrides?.pendingConfirmation ?? null,
    verification: overrides?.verification ?? { status: "notRun" },
    publication: overrides?.publication ?? { status: "notRun" },
    externalFlows: []
  };
}

async function setup(overrides?: Parameters<typeof session>[0]): Promise<{
  root: string;
  store: FileSystemGenerationSessionStore;
  service: GenerationReplaceService;
  verify: ReturnType<typeof vi.fn<VerifyFunction>>;
  prepare: ReturnType<typeof vi.fn<PrepareFunction>>;
  observe: ReturnType<typeof vi.fn<ObserveFunction>>;
}> {
  const root = await mkdtemp(join(tmpdir(), "taphound-replace-service-"));
  roots.push(root);
  const store = new FileSystemGenerationSessionStore(root);
  await store.create(session(overrides));
  const verify = vi.fn<VerifyFunction>(() => Promise.resolve({
    status: "passed" as const,
    exitCode: 0 as const,
    report: {} as VerifyResult["report"],
    reportPath: "/reports/report.json",
    summaryPath: "/reports/summary.txt"
  }));
  const prepare = vi.fn<PrepareFunction>(() => Promise.resolve());
  const observe = vi.fn<ObserveFunction>(() => Promise.resolve(observation(4)));
  const service = new GenerationReplaceService({
    store,
    observer: { observe },
    verifyRuntime: { verify },
    appPreparer: { prepare }
  });
  return { root, store, service, verify, prepare, observe };
}

function baseFlow(stepCount: number): NonNullable<GenerationSession["baseFlow"]> {
  return {
    name: "login",
    resolutionSha256: "4".repeat(64),
    journeySha256: "5".repeat(64),
    verificationReportSha256: "6".repeat(64),
    verificationRunId: "flow-run-1",
    stepCount
  };
}

describe("GenerationReplaceService.replace", () => {
  it("replays the stored prefix, truncates, and observes", async () => {
    const test = await setup();

    const result = await test.service.replace({
      generationId: "generation-1",
      stepIndex: 2,
      projectRoot: test.root,
      config,
      toolVersions: { adb: "1.0.41" }
    });

    expect(test.verify).toHaveBeenCalledOnce();
    const verifyInput = test.verify.mock.calls[0]?.[0];
    expect(verifyInput?.journey.steps).toHaveLength(2);
    expect(verifyInput?.journey.name).toBe("generation-generation-1-prefix-2");
    expect(verifyInput?.devices).toEqual([
      { role: "default", deviceSerial: "emulator-5554" }
    ]);
    expect(verifyInput?.requireFocusedInput).toBe(true);
    expect(verifyInput?.generatedReplayPolicy).toBe(true);
    expect(verifyInput?.toolVersions).toEqual({ adb: "1.0.41" });
    expect(test.prepare).not.toHaveBeenCalled();

    const stored = await test.store.read("generation-1");
    expect(stored.candidateSteps).toHaveLength(2);
    expect(stored.candidateSources).toEqual(["planner", "planner"]);
    expect(stored.revision).toBe(1);

    expect(result).toMatchObject({
      status: "replaced",
      stepIndex: 2,
      remainingStepCount: 2,
      truncatedStepCount: 1
    });
    expect(result.observation.binding.baseRevision).toBe(4);
    expect(test.observe).toHaveBeenCalledWith({
      generationId: "generation-1",
      idle: config.idle
    });
  });

  it("cold-resets instead of replaying at index 0", async () => {
    const test = await setup();

    const result = await test.service.replace({
      generationId: "generation-1",
      stepIndex: 0,
      projectRoot: test.root,
      config,
      toolVersions: { adb: "1.0.41" }
    });

    expect(test.verify).not.toHaveBeenCalled();
    expect(test.prepare).toHaveBeenCalledWith({
      config,
      deviceSerial: "emulator-5554"
    });

    const stored = await test.store.read("generation-1");
    expect(stored.candidateSteps).toHaveLength(0);
    expect(stored.candidateSources).toHaveLength(0);
    expect(stored.revision).toBe(1);

    expect(result.stepIndex).toBe(0);
    expect(result.remainingStepCount).toBe(0);
    expect(result.truncatedStepCount).toBe(3);
  });

  it("skips truncation at the append position", async () => {
    const test = await setup();

    const result = await test.service.replace({
      generationId: "generation-1",
      stepIndex: 3,
      projectRoot: test.root,
      config,
      toolVersions: { adb: "1.0.41" }
    });

    expect(test.verify).toHaveBeenCalledOnce();
    const verifyInput = test.verify.mock.calls[0]?.[0];
    expect(verifyInput?.journey.steps).toHaveLength(3);

    const stored = await test.store.read("generation-1");
    expect(stored.revision).toBe(0);
    expect(stored.candidateSteps).toHaveLength(3);

    expect(result.truncatedStepCount).toBe(0);
    expect(result.remainingStepCount).toBe(3);
  });

  it("substitutes the session idle policy into the replay and cold reset", async () => {
    const test = await setup({ idlePolicy: sessionIdlePolicy });

    await test.service.replace({
      generationId: "generation-1",
      stepIndex: 0,
      projectRoot: test.root,
      config,
      toolVersions: {}
    });

    expect(test.verify).not.toHaveBeenCalled();
    expect(test.prepare).toHaveBeenCalledWith({
      config: { ...config, idle: sessionIdlePolicy },
      deviceSerial: "emulator-5554"
    });
  });

  it("substitutes the session idle policy into the prefix replay config", async () => {
    const test = await setup({ idlePolicy: sessionIdlePolicy });

    await test.service.replace({
      generationId: "generation-1",
      stepIndex: 2,
      projectRoot: test.root,
      config,
      toolVersions: {}
    });

    const verifyInput = test.verify.mock.calls[0]?.[0];
    expect(verifyInput?.config.idle).toEqual(sessionIdlePolicy);
  });

  it("fails with VERIFICATION_FAILED and keeps the session intact", async () => {
    const test = await setup();
    test.verify.mockResolvedValueOnce({
      status: "failed" as const,
      exitCode: 1 as const,
      report: {
        primaryFailure: {
          stepIndex: 1,
          code: "LOCATOR_NOT_FOUND",
          message: "Locator not found"
        }
      } as unknown as VerifyResult["report"],
      reportPath: "/reports/report.json",
      summaryPath: "/reports/summary.txt"
    });

    await expect(test.service.replace({
      generationId: "generation-1",
      stepIndex: 2,
      projectRoot: test.root,
      config,
      toolVersions: {}
    })).rejects.toMatchObject({
      code: "VERIFICATION_FAILED",
      message: /step 1: LOCATOR_NOT_FOUND - Locator not found/
    });

    const stored = await test.store.read("generation-1");
    expect(stored.candidateSteps).toHaveLength(3);
    expect(stored.revision).toBe(0);
    expect(test.observe).not.toHaveBeenCalled();
  });

  it("fails with APP_LAUNCH_FAILED when the cold reset fails", async () => {
    const test = await setup();
    test.prepare.mockRejectedValueOnce(new Error("emulator refused the launch"));

    await expect(test.service.replace({
      generationId: "generation-1",
      stepIndex: 0,
      projectRoot: test.root,
      config,
      toolVersions: {}
    })).rejects.toMatchObject({
      code: "APP_LAUNCH_FAILED",
      message: /emulator refused the launch/
    });

    const stored = await test.store.read("generation-1");
    expect(stored.candidateSteps).toHaveLength(3);
  });

  it.each([
    ["recoveryRequired state", {
      state: "recoveryRequired" as const,
      inFlight: {
        stepIndex: 3,
        snapshotHash: "a".repeat(64),
        proposalHash: "b".repeat(64),
        attemptId: "attempt-1"
      }
    }, "RECOVERY_REQUIRED"],
    ["in-flight step", {
      inFlight: {
        stepIndex: 3,
        snapshotHash: "a".repeat(64),
        proposalHash: "b".repeat(64),
        attemptId: "attempt-1"
      }
    }, "RECOVERY_REQUIRED"],
    ["pending confirmation", {
      pendingConfirmation: {
        challengeId: "challenge-1",
        stepIndex: 3,
        proposalHash: "b".repeat(64),
        snapshotHash: "a".repeat(64),
        evidenceHash: "c".repeat(64),
        actionSummary: "click login",
        expiresAt: "2026-07-23T00:05:00.000Z",
        status: "pending" as const
      }
    }, "RISK_CONFIRMATION_REQUIRED"],
    ["running verification", {
      verification: {
        status: "running" as const,
        attemptId: "attempt-1",
        ownerPid: 42,
        startedAt: "2026-07-23T00:00:00.000Z"
      }
    }, "CONFIG_INVALID"],
    ["published session", {
      verification: {
        status: "passed" as const,
        attemptId: "attempt-1",
        reportPath: ".taphound/build/runs/report.json",
        reportSha256: "e".repeat(64),
        runId: "verify-run-1"
      },
      publication: {
        status: "published" as const,
        journeyPath: ".taphound/journeys/generated.json"
      }
    }, "CONFIG_INVALID"],
    ["archived session", { state: "archived" as const }, "CONFIG_INVALID"]
  ])("rejects replace during a %s", async (_label, overrides, code) => {
    const test = await setup(overrides);

    await expect(test.service.replace({
      generationId: "generation-1",
      stepIndex: 1,
      projectRoot: test.root,
      config,
      toolVersions: {}
    })).rejects.toMatchObject({ code });

    expect(test.verify).not.toHaveBeenCalled();
    expect(test.prepare).not.toHaveBeenCalled();
    expect(test.observe).not.toHaveBeenCalled();
  });

  it("rejects legacy sessions with evidence and no ui backend binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "taphound-replace-service-"));
    roots.push(root);
    const store = new FileSystemGenerationSessionStore(root);
    const legacy = session();
    await store.create({
      ...legacy,
      bindings: {
        projectHash: legacy.bindings.projectHash,
        configHash: legacy.bindings.configHash,
        contextHash: legacy.bindings.contextHash,
        snapshotHash: legacy.bindings.snapshotHash
      }
    });

    const service = new GenerationReplaceService({
      store,
      observer: { observe: vi.fn<ObserveFunction>() },
      verifyRuntime: { verify: vi.fn<VerifyFunction>() },
      appPreparer: { prepare: vi.fn<PrepareFunction>() }
    });

    await expect(service.replace({
      generationId: "generation-1",
      stepIndex: 1,
      projectRoot: root,
      config,
      toolVersions: {}
    })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: /Legacy generation sessions/
    });
  });

  it.each([
    ["negative", -1],
    ["beyond the candidate count", 4],
    ["non-integer", 1.5]
  ])("rejects a %s replace index", async (_label, stepIndex) => {
    const test = await setup();

    await expect(test.service.replace({
      generationId: "generation-1",
      stepIndex,
      projectRoot: test.root,
      config,
      toolVersions: {}
    })).rejects.toMatchObject({ code: "CONFIG_INVALID" });

    expect(test.verify).not.toHaveBeenCalled();
  });

  it("rejects replace targeting the bound Base Flow prefix", async () => {
    const test = await setup({ baseFlow: baseFlow(2), flowStepCount: 2 });

    await expect(test.service.replace({
      generationId: "generation-1",
      stepIndex: 1,
      projectRoot: test.root,
      config,
      toolVersions: {}
    })).rejects.toMatchObject({
      code: "FLOW_INVALID",
      message: /Base Flow prefix/
    });

    expect(test.verify).not.toHaveBeenCalled();
  });

  it("allows replace at and beyond the Base Flow boundary", async () => {
    const test = await setup({ baseFlow: baseFlow(2), flowStepCount: 2 });

    const result = await test.service.replace({
      generationId: "generation-1",
      stepIndex: 2,
      projectRoot: test.root,
      config,
      toolVersions: {}
    });

    expect(result.stepIndex).toBe(2);
    const verifyInput = test.verify.mock.calls[0]?.[0];
    expect(verifyInput?.journey.steps).toHaveLength(2);
    const stored = await test.store.read("generation-1");
    expect(stored.candidateSources).toEqual(["flow", "flow"]);
  });

  it("rejects an unknown session id", async () => {
    const test = await setup();

    await expect(test.service.replace({
      generationId: "generation-missing",
      stepIndex: 0,
      projectRoot: test.root,
      config,
      toolVersions: {}
    })).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });
});
