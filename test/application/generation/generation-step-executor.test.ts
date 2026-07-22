import { describe, expect, it, vi } from "vitest";

import {
  GenerationStepExecutor
} from "../../../src/application/generation/generation-step-executor.js";
import {
  GenerationSessionSchema,
  type GenerationSession
} from "../../../src/domain/generation.js";
import {
  hashProposedStep,
  type ProposedStep
} from "../../../src/domain/proposed-step.js";
import {
  hashRuntimeSnapshot,
  type RuntimeSnapshot
} from "../../../src/domain/runtime-snapshot.js";
import type { CommandResult, RunningCommand } from "../../../src/ports/process-runner.js";

const activity = "com.example.app.MainActivity";
const afterActivity = "com.example.app.AfterActivity";
const ok: CommandResult = {
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  cancelled: false,
  durationMs: 1
};

const target = {
  id: "submit",
  resourceId: "submit",
  text: "Submit run-42",
  enabled: true,
  clickable: true,
  bounds: { left: 0, top: 0, right: 100, bottom: 100 },
  children: []
};

function snapshot(): RuntimeSnapshot {
  return {
    version: 1,
    generationId: "generation-1",
    baseRevision: 2,
    deviceSerial: "emulator-5554",
    expectedPackageName: "com.example.app",
    foregroundPackageName: "com.example.app",
    activity,
    pid: 42,
    capturedAt: "2026-07-22T12:00:00.000Z",
    layout: [target]
  };
}

function proposal(runtime = snapshot()): ProposedStep {
  return {
    action: "click",
    locator: { text: "Submit ${runId}" },
    binding: {
      generationId: "generation-1",
      baseRevision: 2,
      snapshotHash: hashRuntimeSnapshot(runtime)
    },
    activity: { before: activity }
  };
}

function session(
  runtime = snapshot(),
  overrides: Partial<GenerationSession> = {}
): GenerationSession {
  return GenerationSessionSchema.parse({
    version: 1,
    id: "generation-1",
    revision: 2,
    state: "active",
    bindings: {
      projectHash: "a".repeat(64),
      configHash: "b".repeat(64),
      contextHash: "c".repeat(64),
      snapshotHash: hashRuntimeSnapshot(runtime)
    },
    target: {
      packageName: "com.example.app",
      deviceSerial: "emulator-5554",
      resetStrategy: "processOnly",
      interactionPolicy: {
        allowedActions: ["click", "inputText", "scrollTo", "back"],
        confirmationRequiredActions: ["back"],
        forbiddenActions: ["longClick"]
      }
    },
    variables: {
      runId: "run-42",
      timestamp: "2026-07-22T12:00:00.000Z",
      randomHex: "a0"
    },
    candidateSteps: [],
    candidateSources: [],
    inFlight: null,
    pendingConfirmation: null,
    verification: { status: "notRun" },
    publication: { status: "notRun" },
    ...overrides
  });
}

function harness(initial = session()): {
  execute: GenerationStepExecutor["execute"];
  current: () => GenerationSession;
  calls: string[];
  adb: Record<
    | "foregroundComponent"
    | "currentActivity"
    | "pid"
    | "tap"
    | "longClick"
    | "swipe"
    | "back"
    | "inputText"
    | "startLogcat",
    ReturnType<typeof vi.fn>
  >;
  androidCli: {
    layout: ReturnType<typeof vi.fn>;
    layoutDiff: ReturnType<typeof vi.fn>;
  };
  guard: ReturnType<typeof vi.fn>;
  evidence: Map<string, unknown>;
  stopLogcat: ReturnType<typeof vi.fn>;
  writeEvidence: ReturnType<typeof vi.fn>;
} {
  let current = initial;
  const calls: string[] = [];
  const evidence = new Map<string, unknown>();
  let time = 0;
  const stopLogcat = vi.fn(() => Promise.resolve(ok));
  const running: RunningCommand = {
    started: Promise.resolve(undefined),
    completion: Promise.resolve(ok),
    stop: stopLogcat
  };
  const adb = {
    foregroundComponent: vi.fn(() => Promise.resolve({
      packageName: "com.example.app",
      activity: afterActivity
    })),
    currentActivity: vi.fn(() => Promise.resolve(afterActivity)),
    pid: vi.fn(() => Promise.resolve(42)),
    tap: vi.fn(() => {
      calls.push("action");
      return Promise.resolve(ok);
    }),
    longClick: vi.fn(() => Promise.resolve(ok)),
    swipe: vi.fn(() => Promise.resolve(ok)),
    back: vi.fn(() => Promise.resolve(ok)),
    inputText: vi.fn(() => Promise.resolve(ok)),
    startLogcat: vi.fn(() => running)
  };
  const guard = vi.fn(() => {
    calls.push("fresh");
    return Promise.resolve(snapshot());
  });
  const androidCli = {
    layout: vi.fn(() => Promise.resolve(snapshot().layout)),
    layoutDiff: vi.fn(() => Promise.resolve([]))
  };
  const store = {
    read: vi.fn(() => Promise.resolve(current)),
    beginStep: vi.fn((
      _id: string,
      expectedRevision: number,
      inFlight: NonNullable<GenerationSession["inFlight"]>,
      approved?: GenerationSession["pendingConfirmation"]
    ) => {
      calls.push("begin");
      expect(current.revision).toBe(expectedRevision);
      if (approved !== undefined) {
        expect(current.pendingConfirmation).toEqual(approved);
      }
      current = GenerationSessionSchema.parse({
        ...current,
        revision: current.revision + 1,
        inFlight,
        pendingConfirmation: null
      });
      return Promise.resolve(current);
    }),
    completeStep: vi.fn((
      _id: string,
      expectedRevision: number,
      _inFlight: NonNullable<GenerationSession["inFlight"]>,
      next: GenerationSession
    ) => {
      expect(current.revision).toBe(expectedRevision);
      current = GenerationSessionSchema.parse(next);
      return Promise.resolve();
    }),
    update: vi.fn((
      _id: string,
      expectedRevision: number,
      next: GenerationSession
    ) => {
      expect(current.revision).toBe(expectedRevision);
      current = GenerationSessionSchema.parse(next);
      return Promise.resolve();
    }),
    writeEvidence: vi.fn((_id: string, path: string, value: unknown) => {
      evidence.set(path, value);
      return Promise.resolve();
    }),
    writeTextEvidence: vi.fn((_id: string, path: string, value: string) => {
      evidence.set(path, value);
      return Promise.resolve();
    })
  };
  const executor = new GenerationStepExecutor({
    store,
    freshnessGuard: { assertFresh: guard },
    adb: adb as never,
    androidCli: androidCli as never,
    clock: {
      now: (): number => {
        time += 1;
        return time;
      },
      sleep: (): Promise<void> => Promise.resolve()
    },
    idle: { pollIntervalMs: 1, stablePolls: 1, timeoutMs: 10 },
    now: (): Date => new Date("2026-07-22T12:00:01.000Z")
  });
  return {
    execute: executor.execute,
    current: (): GenerationSession => current,
    calls,
    adb,
    androidCli,
    guard,
    evidence,
    stopLogcat,
    writeEvidence: store.writeEvidence
  };
}

describe("GenerationStepExecutor", () => {
  it("durably begins a fresh safe step before ADB action and appends literals with provenance", async () => {
    const runtime = snapshot();
    const test = harness(session(runtime));

    const result = await test.execute({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime,
      source: "manualOverride"
    });

    expect(result.status).toBe("succeeded");
    expect(test.calls.slice(0, 3)).toEqual(["fresh", "begin", "action"]);
    expect(test.current()).toMatchObject({
      state: "active",
      inFlight: null,
      candidateSources: ["manualOverride"],
      candidateSteps: [{
        action: "click",
        locator: { text: "Submit run-42" },
        activity: { before: activity, after: afterActivity }
      }]
    });
    expect(JSON.stringify(test.current().candidateSteps)).not.toContain("${");
  });

  it("consumes only an exact non-expired approved challenge and rejects replay", async () => {
    const runtime = snapshot();
    const step: ProposedStep = {
      action: "back",
      binding: proposal(runtime).binding,
      activity: { before: activity }
    };
    const approved = {
      challengeId: "challenge-1",
      stepIndex: 0,
      proposalHash: hashProposedStep(step),
      snapshotHash: hashRuntimeSnapshot(runtime),
      actionSummary: "Back from com.example.app.MainActivity",
      expiresAt: "2026-07-22T12:00:30.000Z",
      status: "approved" as const
    };
    const test = harness(session(runtime, {
      revision: 4,
      pendingConfirmation: approved
    }));

    await expect(test.execute({
      generationId: "generation-1",
      proposal: step,
      snapshot: runtime,
      source: "planner"
    })).resolves.toMatchObject({ status: "succeeded" });
    await expect(test.execute({
      generationId: "generation-1",
      proposal: step,
      snapshot: runtime,
      source: "planner"
    })).rejects.toMatchObject({ code: "RISK_CONFIRMATION_REQUIRED" });
  });

  it.each([
    ["expired", { expiresAt: "2026-07-22T12:00:00.000Z" }],
    ["proposal mismatch", { proposalHash: "f".repeat(64) }],
    ["snapshot mismatch", { snapshotHash: "f".repeat(64) }],
    ["pending", { status: "pending" as const }]
  ])("rejects %s confirmation before freshness or action", async (_name, change) => {
    const runtime = snapshot();
    const step: ProposedStep = {
      action: "back",
      binding: proposal(runtime).binding,
      activity: { before: activity }
    };
    const test = harness(session(runtime, {
      revision: 4,
      pendingConfirmation: {
        challengeId: "challenge-1",
        stepIndex: 0,
        proposalHash: hashProposedStep(step),
        snapshotHash: hashRuntimeSnapshot(runtime),
        actionSummary: "Back from com.example.app.MainActivity",
        expiresAt: "2026-07-22T12:00:30.000Z",
        status: "approved",
        ...change
      }
    }));

    await expect(test.execute({
      generationId: "generation-1",
      proposal: step,
      snapshot: runtime,
      source: "planner"
    })).rejects.toMatchObject({ code: "RISK_CONFIRMATION_REQUIRED" });
    expect(test.guard).not.toHaveBeenCalled();
    expect(test.adb.back).not.toHaveBeenCalled();
  });

  it("rejects forbidden risk before freshness or action", async () => {
    const runtime = snapshot();
    const test = harness(session(runtime));
    await expect(test.execute({
      generationId: "generation-1",
      proposal: {
        action: "longClick",
        locator: { resourceId: "submit" },
        durationMs: 800,
        binding: proposal(runtime).binding,
        activity: { before: activity }
      },
      snapshot: runtime,
      source: "planner"
    })).rejects.toMatchObject({ code: "ACTION_FORBIDDEN" });
    expect(test.guard).not.toHaveBeenCalled();
  });

  it.each([
    ["package escape", (test: ReturnType<typeof harness>): void => {
      test.adb.foregroundComponent.mockResolvedValueOnce({
        packageName: "com.android.systemui",
        activity: "com.android.systemui.DialogActivity"
      });
    }, "PACKAGE_ESCAPE"],
    ["crash", (test: ReturnType<typeof harness>): void => {
      test.adb.pid.mockResolvedValueOnce(null);
    }, "APP_CRASHED"],
    ["action failure", (test: ReturnType<typeof harness>): void => {
      test.adb.tap.mockResolvedValueOnce({ ...ok, exitCode: 1, stderr: "tap failed" });
    }, "ACTION_FAILED"]
  ])("marks recoveryRequired without append on %s", async (
    _name,
    mutate,
    code
  ) => {
    const runtime = snapshot();
    const test = harness(session(runtime));
    mutate(test);

    const result = await test.execute({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime,
      source: "planner"
    });

    expect(result).toMatchObject({ status: "failed", failure: { code } });
    expect(test.current()).toMatchObject({
      state: "recoveryRequired",
      candidateSteps: [],
      candidateSources: []
    });
    expect(test.current().inFlight).toEqual({
      stepIndex: 0,
      snapshotHash: hashRuntimeSnapshot(runtime),
      proposalHash: hashProposedStep(proposal(runtime))
    });
  });

  it("treats cancellation after begin as recoveryRequired", async () => {
    const runtime = snapshot();
    const test = harness(session(runtime));
    const controller = new AbortController();
    controller.abort();

    const result = await test.execute({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime,
      source: "planner",
      signal: controller.signal
    });

    expect(result.status).toBe("cancelled");
    expect(test.current().state).toBe("recoveryRequired");
    expect(test.current().candidateSteps).toEqual([]);
  });

  it.each([
    ["idle timeout", (test: ReturnType<typeof harness>): void => {
      test.androidCli.layoutDiff.mockResolvedValue([{ changed: true }]);
    }, "IDLE_TIMEOUT"],
    ["action throw", (test: ReturnType<typeof harness>): void => {
      test.adb.tap.mockRejectedValueOnce(new Error("transport closed"));
    }, "INTERNAL_ERROR"],
    ["Logcat stop failure", (test: ReturnType<typeof harness>): void => {
      test.stopLogcat.mockResolvedValueOnce({
        ...ok,
        exitCode: 1,
        stderr: "collector stopped badly"
      });
    }, "COLLECTION_FAILED"]
  ])("preserves inFlight and evidence on %s", async (_name, mutate, code) => {
    const runtime = snapshot();
    const test = harness(session(runtime));
    mutate(test);

    const result = await test.execute({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime,
      source: "planner"
    });

    expect(result).toMatchObject({
      status: "failed",
      failure: { code }
    });
    expect(test.current().state).toBe("recoveryRequired");
    expect(test.current().candidateSteps).toEqual([]);
    expect([...test.evidence.keys()]).toEqual([
      "evidence/steps/001-logcat.txt",
      "evidence/steps/001-result.json"
    ]);
  });

  it("marks recoveryRequired if immutable result evidence cannot be persisted", async () => {
    const runtime = snapshot();
    const test = harness(session(runtime));
    test.writeEvidence.mockRejectedValueOnce(new Error("disk full"));

    await expect(test.execute({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime,
      source: "planner"
    })).rejects.toThrow(/disk full/);

    expect(test.current().state).toBe("recoveryRequired");
    expect(test.current().candidateSteps).toEqual([]);
  });

  it("marks Expect failure recoveryRequired without appending", async () => {
    const runtime = snapshot();
    const test = harness(session(runtime));
    const expected: ProposedStep = {
      ...proposal(runtime),
      expect: {
        type: "element",
        locator: { resourceId: "never-visible" },
        timeoutMs: 3
      }
    };

    const result = await test.execute({
      generationId: "generation-1",
      proposal: expected,
      snapshot: runtime,
      source: "planner"
    });

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "EXPECT_ELEMENT_FAILED" }
    });
    expect(test.current().state).toBe("recoveryRequired");
    expect(test.current().candidateSteps).toEqual([]);
  });

  it("rechecks a unique enabled focused element immediately before inputText", async () => {
    const runtime = snapshot();
    const input: ProposedStep = {
      action: "inputText",
      text: "hello ${runId}",
      binding: proposal(runtime).binding,
      activity: { before: activity }
    };
    const test = harness(session(runtime));

    const result = await test.execute({
      generationId: "generation-1",
      proposal: input,
      snapshot: runtime,
      source: "planner"
    });

    expect(result.status).toBe("failed");
    expect(test.adb.inputText).not.toHaveBeenCalled();
    expect(test.current().state).toBe("recoveryRequired");
  });

  it.each([
    ["found", [{
      id: "list",
      resourceId: "list",
      enabled: true,
      scrollable: true,
      bounds: { left: 0, top: 0, right: 100, bottom: 200 },
      children: [{
        id: "wanted",
        resourceId: "wanted",
        enabled: true,
        bounds: { left: 0, top: 0, right: 10, bottom: 10 },
        children: []
      }]
    }], "succeeded"],
    ["ambiguous", [{
      id: "list",
      resourceId: "list",
      enabled: true,
      scrollable: true,
      bounds: { left: 0, top: 0, right: 100, bottom: 200 },
      children: [
        {
          id: "wanted-1",
          text: "Wanted",
          enabled: true,
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          children: []
        },
        {
          id: "wanted-2",
          text: "Wanted",
          enabled: true,
          bounds: { left: 10, top: 0, right: 20, bottom: 10 },
          children: []
        }
      ]
    }], "failed"]
  ])("shares bounded scrollTo %s behavior with replay", async (
    _name,
    layout,
    expectedStatus
  ) => {
    const runtime = { ...snapshot(), layout };
    const scroll: ProposedStep = {
      action: "scrollTo",
      locator: _name === "found"
        ? { resourceId: "wanted" }
        : { text: "Wanted" },
      container: { resourceId: "list" },
      direction: "up",
      maxSwipes: 1,
      distancePercent: 0.6,
      durationMs: 300,
      binding: {
        generationId: "generation-1",
        baseRevision: 2,
        snapshotHash: hashRuntimeSnapshot(runtime)
      },
      activity: { before: activity }
    };
    const test = harness(session(runtime));
    test.guard.mockResolvedValueOnce(runtime);

    const result = await test.execute({
      generationId: "generation-1",
      proposal: scroll,
      snapshot: runtime,
      source: "planner"
    });

    expect(result.status).toBe(expectedStatus);
    if (_name === "ambiguous") {
      expect(result).toMatchObject({
        failure: { code: "LOCATOR_AMBIGUOUS" }
      });
    }
  });

  it("fails scrollTo deterministically when its bound is exhausted", async () => {
    const layout = [{
      id: "list",
      resourceId: "list",
      enabled: true,
      scrollable: true,
      bounds: { left: 0, top: 0, right: 100, bottom: 200 },
      children: []
    }];
    const runtime = { ...snapshot(), layout };
    const scroll: ProposedStep = {
      action: "scrollTo",
      locator: { resourceId: "wanted" },
      container: { resourceId: "list" },
      direction: "up",
      maxSwipes: 1,
      distancePercent: 0.6,
      durationMs: 300,
      binding: {
        generationId: "generation-1",
        baseRevision: 2,
        snapshotHash: hashRuntimeSnapshot(runtime)
      },
      activity: { before: activity }
    };
    const test = harness(session(runtime));
    test.guard.mockResolvedValueOnce(runtime);
    test.androidCli.layout.mockResolvedValue(layout);

    const result = await test.execute({
      generationId: "generation-1",
      proposal: scroll,
      snapshot: runtime,
      source: "planner"
    });

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "SCROLL_TARGET_NOT_FOUND" }
    });
    expect(test.adb.swipe).toHaveBeenCalledTimes(1);
    expect(test.current().state).toBe("recoveryRequired");
  });
});
