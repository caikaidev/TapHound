import { describe, expect, it, vi } from "vitest";

import {
  GenerationStepExecutor
} from "../../../src/application/generation/generation-step-executor.js";
import {
  GenerationSessionStoreError
} from "../../../src/ports/generation-session-store.js";
import {
  GenerationSessionSchema,
  hashGenerationConfirmationEvidence,
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
      baseRevision: runtime.baseRevision,
      snapshotHash: hashRuntimeSnapshot(runtime)
    },
    activity: { before: activity }
  };
}

function confirmationEvidenceHash(
  step: ProposedStep,
  runtime: RuntimeSnapshot,
  source: "planner" | "manualOverride" = "planner"
): string {
  return hashGenerationConfirmationEvidence({
    version: 1,
    proposal: step,
    snapshot: runtime,
    source
  });
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

function harness(
  initial = session(),
  generateAttemptId: () => string = () => "attempt-1"
): {
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
  writeTextEvidence: ReturnType<typeof vi.fn>;
  beginStep: ReturnType<typeof vi.fn>;
  completeStep: ReturnType<typeof vi.fn>;
  clearApproved: ReturnType<typeof vi.fn>;
  recover: () => void;
  replaceCurrent: (next: GenerationSession) => void;
  afterBegin: (callback: () => void) => void;
  setNow: (next: Date) => void;
} {
  let current = initial;
  const calls: string[] = [];
  const evidence = new Map<string, unknown>();
  let beginCallback: (() => void) | undefined;
  let time = 0;
  let now = new Date("2026-07-22T12:00:01.000Z");
  const stopLogcat = vi.fn(() => Promise.resolve(ok));
  const running: RunningCommand = {
    started: Promise.resolve(undefined),
    completion: Promise.resolve(ok),
    stop: stopLogcat
  };
  let foregroundCalls = 0;
  const adb = {
    foregroundComponent: vi.fn(() => {
      foregroundCalls += 1;
      return Promise.resolve({
        packageName: "com.example.app",
        activity: foregroundCalls <= 3 ? activity : afterActivity
      });
    }),
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
  const clearApproved = vi.fn((
    generationId: string,
    challenge: NonNullable<GenerationSession["pendingConfirmation"]>
  ): Promise<void> => {
    if (
      current.id === generationId
      && JSON.stringify(current.pendingConfirmation)
        === JSON.stringify(challenge)
      && challenge.status === "approved"
    ) {
      current = GenerationSessionSchema.parse({
        ...current,
        revision: current.revision + 1,
        pendingConfirmation: null
      });
    }
    return Promise.resolve();
  });
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
    if (approved !== undefined && approved !== null) {
        expect(current.pendingConfirmation).toEqual(approved);
      if (now.getTime() >= new Date(approved.expiresAt).getTime()) {
        throw new Error("Approved confirmation expired before step begin");
      }
      }
      current = GenerationSessionSchema.parse({
        ...current,
        revision: current.revision + 1,
        inFlight,
        pendingConfirmation: null
      });
      beginCallback?.();
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
    now: (): Date => now,
    generateAttemptId,
    clearApprovedConfirmation: clearApproved
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
    writeEvidence: store.writeEvidence,
    writeTextEvidence: store.writeTextEvidence,
    beginStep: store.beginStep,
    completeStep: store.completeStep,
    clearApproved,
    recover: (): void => {
      current = GenerationSessionSchema.parse({
        ...current,
        revision: current.revision + 1,
        state: "active",
        inFlight: null
      });
    },
    replaceCurrent: (next): void => {
      current = GenerationSessionSchema.parse(next);
    },
    afterBegin: (callback): void => {
      beginCallback = callback;
    },
    setNow: (next): void => {
      now = next;
    }
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
    expect(test.evidence.get(
      "evidence/steps/0-attempt-1/proposal.json"
    )).toEqual(proposal(runtime));
    expect(test.evidence.get(
      "evidence/steps/0-attempt-1/snapshot.json"
    )).toEqual(runtime);
    expect(test.evidence.get(
      "evidence/steps/0-attempt-1/result.json"
    )).toMatchObject({
      version: 1,
      stepIndex: 0,
      attemptId: "attempt-1",
      source: "manualOverride",
      proposalEvidence: {
        path: "evidence/steps/0-attempt-1/proposal.json"
      },
      snapshotEvidence: {
        path: "evidence/steps/0-attempt-1/snapshot.json"
      }
    });
    expect(JSON.stringify(test.evidence.get(
      "evidence/steps/0-attempt-1/result.json"
    ))).toMatch(/"sha256":"[a-f0-9]{64}"/);
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
      evidenceHash: confirmationEvidenceHash(step, runtime),
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
    expect(test.clearApproved).not.toHaveBeenCalled();
    await expect(test.execute({
      generationId: "generation-1",
      proposal: step,
      snapshot: runtime,
      source: "planner"
    })).rejects.toMatchObject({ code: "RISK_CONFIRMATION_REQUIRED" });
  });

  it.each([
    ["expired", { expiresAt: "2026-07-22T12:00:00.000Z" }, 4],
    ["proposal mismatch", { proposalHash: "f".repeat(64) }, 4],
    ["snapshot mismatch", { snapshotHash: "f".repeat(64) }, 4],
    ["evidence mismatch", { evidenceHash: "f".repeat(64) }, 4],
    ["pending", { status: "pending" as const }, 4],
    ["revision mismatch", {}, 5]
  ])("rejects %s confirmation before freshness or action", async (
    _name,
    change,
    revision
  ) => {
    const runtime = snapshot();
    const step: ProposedStep = {
      action: "back",
      binding: proposal(runtime).binding,
      activity: { before: activity }
    };
    const test = harness(session(runtime, {
      revision,
      pendingConfirmation: {
        challengeId: "challenge-1",
        stepIndex: 0,
        proposalHash: hashProposedStep(step),
        snapshotHash: hashRuntimeSnapshot(runtime),
        evidenceHash: confirmationEvidenceHash(step, runtime),
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
    if (
      _name === "expired"
      || _name === "evidence mismatch"
      || _name === "revision mismatch"
    ) {
      expect(test.clearApproved).toHaveBeenCalledTimes(1);
      expect(test.current().pendingConfirmation).toBeNull();
    }
  });

  it("rejects provenance tampering and clears only the exact approval", async () => {
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
      evidenceHash: confirmationEvidenceHash(
        step,
        runtime,
        "manualOverride"
      ),
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
    })).rejects.toMatchObject({ code: "RISK_CONFIRMATION_REQUIRED" });
    expect(test.guard).not.toHaveBeenCalled();
    expect(test.current().pendingConfirmation).toBeNull();
  });

  it("clears the exact approval when freshness fails before durable begin", async () => {
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
      evidenceHash: confirmationEvidenceHash(step, runtime),
      actionSummary: "Back from com.example.app.MainActivity",
      expiresAt: "2026-07-22T12:00:30.000Z",
      status: "approved" as const
    };
    const test = harness(session(runtime, {
      revision: 4,
      pendingConfirmation: approved
    }));
    test.guard.mockRejectedValueOnce(new Error("Runtime changed"));

    await expect(test.execute({
      generationId: "generation-1",
      proposal: step,
      snapshot: runtime,
      source: "planner"
    })).rejects.toThrow(/runtime changed/i);
    expect(test.beginStep).not.toHaveBeenCalled();
    expect(test.clearApproved).toHaveBeenCalledWith(
      "generation-1",
      approved
    );
    expect(test.current().pendingConfirmation).toBeNull();
    expect(test.adb.back).not.toHaveBeenCalled();
  });

  it("clears the exact approval when cancelled during freshness", async () => {
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
      evidenceHash: confirmationEvidenceHash(step, runtime),
      actionSummary: "Back from com.example.app.MainActivity",
      expiresAt: "2026-07-22T12:00:30.000Z",
      status: "approved" as const
    };
    const controller = new AbortController();
    const test = harness(session(runtime, {
      revision: 4,
      pendingConfirmation: approved
    }));
    test.guard.mockImplementationOnce(((
      _binding: unknown,
      signal?: AbortSignal
    ): Promise<RuntimeSnapshot> => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        reject(new Error("Freshness cancelled"));
      }, { once: true });
    })) as never);
    const execution = test.execute({
      generationId: "generation-1",
      proposal: step,
      snapshot: runtime,
      source: "planner",
      signal: controller.signal
    });
    await vi.waitFor(() => {
      expect(test.guard).toHaveBeenCalledTimes(1);
    });

    controller.abort();

    await expect(execution).resolves.toMatchObject({ status: "cancelled" });
    expect(test.beginStep).not.toHaveBeenCalled();
    expect(test.current().pendingConfirmation).toBeNull();
    expect(test.adb.back).not.toHaveBeenCalled();
  });

  it("clears the exact approval when already cancelled before execution", async () => {
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
      evidenceHash: confirmationEvidenceHash(step, runtime),
      actionSummary: "Back from com.example.app.MainActivity",
      expiresAt: "2026-07-22T12:00:30.000Z",
      status: "approved" as const
    };
    const controller = new AbortController();
    controller.abort();
    const test = harness(session(runtime, {
      revision: 4,
      pendingConfirmation: approved
    }));

    await expect(test.execute({
      generationId: "generation-1",
      proposal: step,
      snapshot: runtime,
      source: "planner",
      signal: controller.signal
    })).resolves.toMatchObject({ status: "cancelled" });
    expect(test.guard).not.toHaveBeenCalled();
    expect(test.current().pendingConfirmation).toBeNull();
    expect(test.adb.back).not.toHaveBeenCalled();
  });

  it("preserves a concurrent replacement when pre-begin cleanup runs", async () => {
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
      evidenceHash: confirmationEvidenceHash(step, runtime),
      actionSummary: "Back from com.example.app.MainActivity",
      expiresAt: "2026-07-22T12:00:30.000Z",
      status: "approved" as const
    };
    const replacement = {
      ...approved,
      challengeId: "challenge-2"
    };
    const test = harness(session(runtime, {
      revision: 4,
      pendingConfirmation: approved
    }));
    test.guard.mockImplementationOnce(((): Promise<RuntimeSnapshot> => {
      test.replaceCurrent(session(runtime, {
        revision: 5,
        pendingConfirmation: replacement
      }));
      return Promise.reject(new Error("Runtime changed"));
    }) as never);

    await expect(test.execute({
      generationId: "generation-1",
      proposal: step,
      snapshot: runtime,
      source: "planner"
    })).rejects.toThrow(/runtime changed/i);
    expect(test.current().pendingConfirmation).toEqual(replacement);
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
      proposalHash: hashProposedStep(proposal(runtime)),
      attemptId: "attempt-1"
    });
  });

  it("treats cancellation after begin as recoveryRequired", async () => {
    const runtime = snapshot();
    const test = harness(session(runtime));
    const controller = new AbortController();
    test.afterBegin(() => {
      controller.abort();
    });

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

  it("cancels before begin without creating inFlight state", async () => {
    const runtime = snapshot();
    const test = harness(session(runtime));
    const controller = new AbortController();
    controller.abort();

    await expect(test.execute({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime,
      source: "planner",
      signal: controller.signal
    })).resolves.toMatchObject({ status: "cancelled" });

    expect(test.calls).toEqual([]);
    expect(test.current().inFlight).toBeNull();
  });

  it("cancels after freshness without creating inFlight state", async () => {
    const runtime = snapshot();
    const test = harness(session(runtime));
    const controller = new AbortController();
    test.guard.mockImplementationOnce((() => {
      controller.abort();
      return Promise.resolve(runtime);
    }) as never);

    await expect(test.execute({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime,
      source: "planner",
      signal: controller.signal
    })).resolves.toMatchObject({ status: "cancelled" });

    expect(test.beginStep).not.toHaveBeenCalled();
    expect(test.current().inFlight).toBeNull();
  });

  it.each([
    ["Logcat start", (
      test: ReturnType<typeof harness>,
      controller: AbortController,
      runtime: RuntimeSnapshot
    ): ProposedStep => {
      test.adb.startLogcat.mockImplementationOnce((() => {
        let resolveStarted: (result: undefined) => void = () => undefined;
        const started = new Promise<undefined>((resolve) => {
          resolveStarted = resolve;
        });
        queueMicrotask(() => {
          controller.abort();
          resolveStarted(undefined);
        });
        return {
          started,
          completion: Promise.resolve(ok),
          stop: test.stopLogcat
        };
      }) as never);
      return proposal(runtime);
    }],
    ["pre-action observation", (
      test: ReturnType<typeof harness>,
      controller: AbortController,
      runtime: RuntimeSnapshot
    ): ProposedStep => {
      test.adb.foregroundComponent.mockImplementationOnce((() => {
        controller.abort();
        return Promise.resolve({
          packageName: "com.example.app",
          activity
        });
      }) as never);
      return proposal(runtime);
    }],
    ["action", (
      test: ReturnType<typeof harness>,
      controller: AbortController,
      runtime: RuntimeSnapshot
    ): ProposedStep => {
      test.adb.tap.mockImplementationOnce((() => {
        controller.abort();
        return Promise.resolve(ok);
      }) as never);
      return proposal(runtime);
    }],
    ["idle wait", (
      test: ReturnType<typeof harness>,
      controller: AbortController,
      runtime: RuntimeSnapshot
    ): ProposedStep => {
      test.androidCli.layoutDiff.mockImplementationOnce((() => {
        controller.abort();
        return Promise.resolve([]);
      }) as never);
      return proposal(runtime);
    }],
    ["Expect", (
      test: ReturnType<typeof harness>,
      controller: AbortController,
      runtime: RuntimeSnapshot
    ): ProposedStep => {
      let actionCompleted = false;
      let postActionForegroundObservations = 0;
      test.adb.tap.mockImplementationOnce((() => {
        actionCompleted = true;
        return Promise.resolve(ok);
      }) as never);
      test.adb.foregroundComponent.mockImplementation((() => {
        if (
          actionCompleted
          && ++postActionForegroundObservations === 4
        ) {
          controller.abort();
        }
        return Promise.resolve({
          packageName: "com.example.app",
          activity: actionCompleted ? afterActivity : activity
        });
      }) as never);
      return {
        ...proposal(runtime),
        expect: {
          type: "activity",
          value: afterActivity,
          timeoutMs: 10
        }
      };
    }],
    ["Logcat stop", (
      test: ReturnType<typeof harness>,
      controller: AbortController,
      runtime: RuntimeSnapshot
    ): ProposedStep => {
      test.stopLogcat.mockImplementationOnce((() => {
        controller.abort();
        return Promise.resolve(ok);
      }) as never);
      return proposal(runtime);
    }]
  ])("preserves inFlight when cancelled after %s", async (
    _name,
    setup
  ) => {
    const runtime = snapshot();
    const test = harness(session(runtime));
    const controller = new AbortController();
    const step = setup(test, controller, runtime);

    await expect(test.execute({
      generationId: "generation-1",
      proposal: step,
      snapshot: runtime,
      source: "planner",
      signal: controller.signal
    })).resolves.toMatchObject({ status: "cancelled" });

    expect(test.current().state).toBe("recoveryRequired");
    expect(test.current().inFlight).not.toBeNull();
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
      "evidence/steps/0-attempt-1/proposal.json",
      "evidence/steps/0-attempt-1/snapshot.json",
      "evidence/steps/0-attempt-1/logcat.txt",
      "evidence/steps/0-attempt-1/result.json"
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

  it.each([
    ["Logcat evidence", (
      test: ReturnType<typeof harness>,
      controller: AbortController
    ): void => {
      test.writeTextEvidence.mockImplementationOnce((() => {
        controller.abort();
        return Promise.resolve();
      }) as never);
    }],
    ["result evidence", (
      test: ReturnType<typeof harness>,
      controller: AbortController
    ): void => {
      test.writeEvidence.mockImplementationOnce((() => {
        controller.abort();
        return Promise.resolve();
      }) as never);
    }]
  ])("marks recovery when cancelled after %s write", async (_name, setup) => {
    const runtime = snapshot();
    const test = harness(session(runtime));
    const controller = new AbortController();
    setup(test, controller);

    await expect(test.execute({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime,
      source: "planner",
      signal: controller.signal
    })).resolves.toMatchObject({ status: "cancelled" });

    expect(test.completeStep).not.toHaveBeenCalled();
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

  it("does not begin when confirmation expires during freshness", async () => {
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
      evidenceHash: confirmationEvidenceHash(step, runtime),
      actionSummary: "Back from com.example.app.MainActivity",
      expiresAt: "2026-07-22T12:00:30.000Z",
      status: "approved" as const
    };
    const test = harness(session(runtime, {
      revision: 4,
      pendingConfirmation: approved
    }));
    test.guard.mockImplementationOnce((() => {
      test.setNow(new Date("2026-07-22T12:00:31.000Z"));
      return Promise.resolve(runtime);
    }) as never);

    await expect(test.execute({
      generationId: "generation-1",
      proposal: step,
      snapshot: runtime,
      source: "planner"
    })).rejects.toThrow(/expired/);

    expect(test.current().inFlight).toBeNull();
    expect(test.current().pendingConfirmation).toBeNull();
    expect(test.adb.back).not.toHaveBeenCalled();
  });

  it.each([
    ["package escape", (test: ReturnType<typeof harness>): void => {
      test.adb.foregroundComponent.mockResolvedValueOnce({
        packageName: "com.android.systemui",
        activity: "com.android.systemui.Dialog"
      });
    }, "PACKAGE_ESCAPE"],
    ["Activity drift", (test: ReturnType<typeof harness>): void => {
      test.adb.foregroundComponent.mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: "com.example.app.OtherActivity"
      });
    }, "SNAPSHOT_STALE"],
    ["missing PID", (test: ReturnType<typeof harness>): void => {
      test.adb.pid.mockResolvedValueOnce(null);
    }, "APP_CRASHED"],
    ["replaced PID", (test: ReturnType<typeof harness>): void => {
      test.adb.pid.mockResolvedValueOnce(99);
    }, "APP_CRASHED"],
    ["Layout drift", (test: ReturnType<typeof harness>): void => {
      test.androidCli.layout.mockResolvedValueOnce([{
        ...target,
        text: "Changed"
      }]);
    }, "SNAPSHOT_STALE"]
  ])("blocks action on post-begin %s", async (_name, mutate, code) => {
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
    expect(test.adb.tap).not.toHaveBeenCalled();
    expect(test.current().state).toBe("recoveryRequired");
  });

  it.each([
    ["package", "PACKAGE_ESCAPE"],
    ["Activity", "SNAPSHOT_STALE"],
    ["PID", "APP_CRASHED"]
  ])("blocks action when %s changes while Layout is pending", async (
    identity,
    code
  ) => {
    const runtime = snapshot();
    const test = harness(session(runtime));
    let layoutReturned = false;
    test.adb.foregroundComponent.mockImplementation((() => Promise.resolve({
      packageName: identity === "package" && layoutReturned
        ? "com.android.systemui"
        : "com.example.app",
      activity: identity === "Activity" && layoutReturned
        ? "com.example.app.OtherActivity"
        : activity
    })) as never);
    test.adb.pid.mockImplementation((() => Promise.resolve(
      identity === "PID" && layoutReturned ? 99 : 42
    )) as never);
    test.androidCli.layout.mockImplementationOnce((async () => {
      await Promise.resolve();
      layoutReturned = true;
      return runtime.layout;
    }) as never);

    const result = await test.execute({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime,
      source: "planner"
    });

    expect(result).toMatchObject({ status: "failed", failure: { code } });
    expect(test.adb.tap).not.toHaveBeenCalled();
    expect(test.current().state).toBe("recoveryRequired");
  });

  it("detects PID replacement after the action", async () => {
    const runtime = snapshot();
    const test = harness(session(runtime));
    test.adb.pid
      .mockResolvedValueOnce(42)
      .mockResolvedValueOnce(42)
      .mockResolvedValueOnce(42)
      .mockResolvedValueOnce(99);

    const result = await test.execute({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime,
      source: "planner"
    });

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "APP_CRASHED" }
    });
    expect(test.current().state).toBe("recoveryRequired");
  });

  it("rechecks identity after Expect passes", async () => {
    const runtime = snapshot();
    const test = harness(session(runtime));
    test.adb.foregroundComponent
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: afterActivity
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: afterActivity
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: afterActivity
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: "com.example.app.EscapedActivity"
      });
    const expected: ProposedStep = {
      ...proposal(runtime),
      expect: {
        type: "activity",
        value: afterActivity,
        timeoutMs: 10
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
      failure: { code: "SNAPSHOT_STALE" }
    });
  });

  it("lets an Activity Expect poll from checkpoint A to expected B", async () => {
    const runtime = snapshot();
    const test = harness(session(runtime));
    let actionCompleted = false;
    let postActionForegroundObservations = 0;
    test.adb.tap.mockImplementationOnce((() => {
      actionCompleted = true;
      return Promise.resolve(ok);
    }) as never);
    test.adb.foregroundComponent.mockImplementation((() => {
      const observation = actionCompleted
        ? ++postActionForegroundObservations
        : 0;
      return Promise.resolve({
        packageName: "com.example.app",
        activity: observation >= 4
          ? "com.example.app.ResultsActivity"
          : (actionCompleted ? afterActivity : activity)
      });
    }) as never);

    const result = await test.execute({
      generationId: "generation-1",
      proposal: {
        ...proposal(runtime),
        expect: {
          type: "activity",
          value: "com.example.app.ResultsActivity",
          timeoutMs: 200
        }
      },
      snapshot: runtime,
      source: "planner"
    });

    expect(result).toMatchObject({
      status: "succeeded",
      step: {
        activity: {
          before: activity,
          after: afterActivity
        },
        expect: {
          type: "activity",
          value: "com.example.app.ResultsActivity"
        }
      }
    });
    expect(postActionForegroundObservations).toBe(6);
  });

  it("preserves persistent foreign Activity Expect failure evidence", async () => {
    const runtime = snapshot();
    const test = harness(session(runtime));
    let actionCompleted = false;
    let postActionForegroundObservations = 0;
    test.adb.tap.mockImplementationOnce((() => {
      actionCompleted = true;
      return Promise.resolve(ok);
    }) as never);
    test.adb.foregroundComponent.mockImplementation((() => {
      const observation = actionCompleted
        ? ++postActionForegroundObservations
        : 0;
      return Promise.resolve({
        packageName: observation >= 3
          ? "com.foreign.app"
          : "com.example.app",
        activity: observation >= 3
          ? "com.example.app.ResultsActivity"
          : (actionCompleted ? afterActivity : activity)
      });
    }) as never);

    const result = await test.execute({
      generationId: "generation-1",
      proposal: {
        ...proposal(runtime),
        expect: {
          type: "activity",
          value: "com.example.app.ResultsActivity",
          timeoutMs: 200
        }
      },
      snapshot: runtime,
      source: "planner"
    });

    expect(result).toMatchObject({
      status: "failed",
      failure: {
        code: "EXPECT_ACTIVITY_FAILED",
        message: "Foreground package escaped generation target"
      }
    });
    expect(test.current()).toMatchObject({
      state: "recoveryRequired",
      candidateSteps: []
    });
    expect(test.evidence.get(
      "evidence/steps/0-attempt-1/result.json"
    )).toMatchObject({
      outcome: {
        status: "failed",
        failure: { code: "EXPECT_ACTIVITY_FAILED" }
      }
    });
  });

  it("preserves persistent Activity Expect PID failure evidence", async () => {
    const runtime = snapshot();
    const test = harness(session(runtime));
    let actionCompleted = false;
    let postActionPidObservations = 0;
    test.adb.tap.mockImplementationOnce((() => {
      actionCompleted = true;
      return Promise.resolve(ok);
    }) as never);
    test.adb.pid.mockImplementation((() => Promise.resolve(
      actionCompleted && ++postActionPidObservations >= 3 ? 99 : 42
    )) as never);

    const result = await test.execute({
      generationId: "generation-1",
      proposal: {
        ...proposal(runtime),
        expect: {
          type: "activity",
          value: "com.example.app.ResultsActivity",
          timeoutMs: 200
        }
      },
      snapshot: runtime,
      source: "planner"
    });

    expect(result).toMatchObject({
      status: "failed",
      failure: {
        code: "EXPECT_ACTIVITY_FAILED",
        message: "Generation process identity changed"
      }
    });
    expect(test.current()).toMatchObject({
      state: "recoveryRequired",
      candidateSteps: []
    });
    expect(test.evidence.get(
      "evidence/steps/0-attempt-1/result.json"
    )).toMatchObject({
      outcome: {
        status: "failed",
        failure: { code: "EXPECT_ACTIVITY_FAILED" }
      }
    });
  });

  it("fails an Activity Expect on a transient foreign foreground package", async () => {
    const runtime = snapshot();
    const test = harness(session(runtime));
    let actionCompleted = false;
    let postActionForegroundObservations = 0;
    test.adb.tap.mockImplementationOnce((() => {
      actionCompleted = true;
      return Promise.resolve(ok);
    }) as never);
    test.adb.foregroundComponent.mockImplementation((() => {
      const observation = actionCompleted
        ? ++postActionForegroundObservations
        : 0;
      return Promise.resolve({
        packageName: observation === 3
          ? "com.foreign.app"
          : "com.example.app",
        activity: actionCompleted ? afterActivity : activity
      });
    }) as never);

    const result = await test.execute({
      generationId: "generation-1",
      proposal: {
        ...proposal(runtime),
        expect: {
          type: "activity",
          value: afterActivity,
          timeoutMs: 10
        }
      },
      snapshot: runtime,
      source: "planner"
    });

    expect(result).toMatchObject({
      status: "failed",
      failure: {
        code: "EXPECT_ACTIVITY_FAILED",
        message: "Foreground package escaped generation target"
      }
    });
    expect(test.current().state).toBe("recoveryRequired");
  });

  it("fails an Element Expect when PID changes during Layout", async () => {
    const runtime = snapshot();
    const test = harness(session(runtime));
    let actionCompleted = false;
    let postActionPidObservations = 0;
    test.adb.tap.mockImplementationOnce((() => {
      actionCompleted = true;
      return Promise.resolve(ok);
    }) as never);
    test.adb.pid.mockImplementation((() => Promise.resolve(
      actionCompleted && ++postActionPidObservations >= 4 ? 99 : 42
    )) as never);

    const result = await test.execute({
      generationId: "generation-1",
      proposal: {
        ...proposal(runtime),
        expect: {
          type: "element",
          locator: { resourceId: "missing" },
          timeoutMs: 10
        }
      },
      snapshot: runtime,
      source: "planner"
    });

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "EXPECT_ELEMENT_FAILED" }
    });
    expect(test.current().state).toBe("recoveryRequired");
    expect(test.evidence.get(
      "evidence/steps/0-attempt-1/result.json"
    )).toMatchObject({
      outcome: {
        status: "failed",
        failure: { code: "EXPECT_ELEMENT_FAILED" }
      }
    });
  });

  it("preserves persistent Element Layout Activity guard failure", async () => {
    const runtime = snapshot();
    const test = harness(session(runtime));
    let actionCompleted = false;
    let postActionForegroundObservations = 0;
    test.adb.tap.mockImplementationOnce((() => {
      actionCompleted = true;
      return Promise.resolve(ok);
    }) as never);
    test.adb.foregroundComponent.mockImplementation((() => {
      const observation = actionCompleted
        ? ++postActionForegroundObservations
        : 0;
      return Promise.resolve({
        packageName: "com.example.app",
        activity: observation >= 4
          ? "com.example.app.OtherActivity"
          : (actionCompleted ? afterActivity : activity)
      });
    }) as never);

    const result = await test.execute({
      generationId: "generation-1",
      proposal: {
        ...proposal(runtime),
        expect: {
          type: "element",
          locator: { resourceId: "missing" },
          timeoutMs: 200
        }
      },
      snapshot: runtime,
      source: "planner"
    });

    expect(result).toMatchObject({
      status: "failed",
      failure: {
        code: "EXPECT_ELEMENT_FAILED",
        message: "Generation Activity changed unexpectedly"
      }
    });
    expect(test.current()).toMatchObject({
      state: "recoveryRequired",
      candidateSteps: []
    });
    expect(test.evidence.get(
      "evidence/steps/0-attempt-1/result.json"
    )).toMatchObject({
      outcome: {
        status: "failed",
        failure: { code: "EXPECT_ELEMENT_FAILED" }
      }
    });
  });

  it("accepts durable completion when the completion call throws afterward", async () => {
    const runtime = snapshot();
    const test = harness(session(runtime));
    test.completeStep.mockImplementationOnce(((
      _id: string,
      _expectedRevision: number,
      _inFlight: NonNullable<GenerationSession["inFlight"]>,
      next: GenerationSession
    ) => {
      test.replaceCurrent(next);
      return Promise.reject(new Error("directory sync failed"));
    }) as never);

    await expect(test.execute({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime,
      source: "planner"
    })).resolves.toMatchObject({ status: "succeeded" });
    expect(test.current().candidateSteps).toHaveLength(1);
  });

  it("fails closed when completion throws with conflicting state", async () => {
    const runtime = snapshot();
    const initial = session(runtime);
    const test = harness(initial);
    test.completeStep.mockImplementationOnce((() => {
      test.replaceCurrent({
        ...initial,
        revision: initial.revision + 2
      });
      return Promise.reject(new Error("directory sync failed"));
    }) as never);

    await expect(test.execute({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime,
      source: "planner"
    })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(test.current().candidateSteps).toEqual([]);
  });

  it("uses distinct immutable evidence paths across recovered retries", async () => {
    const attemptIds = ["attempt-1", "attempt-2"];
    const runtime = snapshot();
    const test = harness(
      session(runtime),
      () => attemptIds.shift() ?? "unexpected"
    );
    test.adb.tap.mockRejectedValue(new Error("transport closed"));

    await test.execute({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime,
      source: "planner"
    });
    test.recover();
    const retryRuntime = {
      ...runtime,
      baseRevision: test.current().revision
    };
    test.replaceCurrent({
      ...test.current(),
      bindings: {
        ...test.current().bindings,
        snapshotHash: hashRuntimeSnapshot(retryRuntime)
      }
    });
    test.guard.mockResolvedValueOnce(retryRuntime);
    await test.execute({
      generationId: "generation-1",
      proposal: proposal(retryRuntime),
      snapshot: retryRuntime,
      source: "planner"
    });

    expect([...test.evidence.keys()]).toEqual([
      "evidence/steps/0-attempt-1/proposal.json",
      "evidence/steps/0-attempt-1/snapshot.json",
      "evidence/steps/0-attempt-1/logcat.txt",
      "evidence/steps/0-attempt-1/result.json",
      "evidence/steps/0-attempt-2/proposal.json",
      "evidence/steps/0-attempt-2/snapshot.json",
      "evidence/steps/0-attempt-2/logcat.txt",
      "evidence/steps/0-attempt-2/result.json"
    ]);
  });

  it("does not mutate the device when a recovered attempt id collides", async () => {
    const runtime = snapshot();
    const test = harness(session(runtime));
    test.beginStep.mockRejectedValueOnce(
      new GenerationSessionStoreError(
        "EVIDENCE_ALREADY_EXISTS",
        "Attempt evidence namespace already exists"
      )
    );

    await expect(test.execute({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime,
      source: "planner"
    })).rejects.toMatchObject({ code: "EVIDENCE_ALREADY_EXISTS" });

    expect(test.adb.startLogcat).not.toHaveBeenCalled();
    expect(test.adb.tap).not.toHaveBeenCalled();
    expect(test.current().inFlight).toBeNull();
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
    test.androidCli.layout.mockResolvedValue(layout);
    test.adb.foregroundComponent.mockResolvedValue({
      packageName: "com.example.app",
      activity
    });

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
    test.adb.foregroundComponent.mockResolvedValue({
      packageName: "com.example.app",
      activity
    });

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

  it("blocks a scroll swipe when live identity escapes", async () => {
    const layout = [{
      id: "list",
      resourceId: "list",
      enabled: true,
      scrollable: true,
      bounds: { left: 0, top: 0, right: 100, bottom: 200 },
      children: []
    }];
    const runtime = { ...snapshot(), layout };
    const test = harness(session(runtime));
    test.guard.mockResolvedValueOnce(runtime);
    test.androidCli.layout.mockResolvedValue(layout);
    test.adb.foregroundComponent
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity
      })
      .mockResolvedValueOnce({
        packageName: "com.android.systemui",
        activity: "com.android.systemui.Dialog"
      });
    const scroll: ProposedStep = {
      action: "scrollTo",
      locator: { resourceId: "wanted" },
      container: { resourceId: "list" },
      direction: "up",
      maxSwipes: 1,
      distancePercent: 0.6,
      durationMs: 300,
      binding: proposal(runtime).binding,
      activity: { before: activity }
    };

    const result = await test.execute({
      generationId: "generation-1",
      proposal: scroll,
      snapshot: runtime,
      source: "planner"
    });

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "PACKAGE_ESCAPE" }
    });
    expect(test.adb.swipe).not.toHaveBeenCalled();
  });

  it.each([
    ["package", "PACKAGE_ESCAPE"],
    ["PID", "APP_CRASHED"]
  ])("blocks a scroll swipe when %s changes while Layout is pending", async (
    identity,
    code
  ) => {
    const layout = [{
      id: "list",
      resourceId: "list",
      enabled: true,
      scrollable: true,
      bounds: { left: 0, top: 0, right: 100, bottom: 200 },
      children: []
    }];
    const runtime = { ...snapshot(), layout };
    const test = harness(session(runtime));
    let layoutCalls = 0;
    let escaped = false;
    test.guard.mockResolvedValueOnce(runtime);
    test.androidCli.layout.mockImplementation((async () => {
      layoutCalls += 1;
      await Promise.resolve();
      if (layoutCalls === 2) {
        escaped = true;
      }
      return layout;
    }) as never);
    test.adb.foregroundComponent.mockImplementation((() => Promise.resolve({
      packageName: identity === "package" && escaped
        ? "com.android.systemui"
        : "com.example.app",
      activity
    })) as never);
    test.adb.pid.mockImplementation((() => Promise.resolve(
      identity === "PID" && escaped ? 99 : 42
    )) as never);
    const scroll: ProposedStep = {
      action: "scrollTo",
      locator: { resourceId: "wanted" },
      container: { resourceId: "list" },
      direction: "up",
      maxSwipes: 1,
      distancePercent: 0.6,
      durationMs: 300,
      binding: proposal(runtime).binding,
      activity: { before: activity }
    };

    const result = await test.execute({
      generationId: "generation-1",
      proposal: scroll,
      snapshot: runtime,
      source: "planner"
    });

    expect(result).toMatchObject({ status: "failed", failure: { code } });
    expect(test.adb.swipe).not.toHaveBeenCalled();
    expect(test.current().state).toBe("recoveryRequired");
  });
});
