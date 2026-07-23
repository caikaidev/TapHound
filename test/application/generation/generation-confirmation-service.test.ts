import { describe, expect, it, vi, type Mock } from "vitest";

import {
  GenerationConfirmationService,
  confirmationEvidencePath
} from "../../../src/application/generation/generation-confirmation-service.js";
import {
  GenerationSessionSchema,
  type GenerationSession,
  type PendingConfirmation
} from "../../../src/domain/generation.js";
import type { ProposedStep } from "../../../src/domain/proposed-step.js";
import {
  hashRuntimeSnapshot,
  type RuntimeSnapshot
} from "../../../src/domain/runtime-snapshot.js";

const activity = "com.example.app.MainActivity";

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
    layout: []
  };
}

function proposal(runtime = snapshot()): ProposedStep {
  return {
    action: "back",
    binding: {
      generationId: "generation-1",
      baseRevision: 2,
      snapshotHash: hashRuntimeSnapshot(runtime)
    },
    activity: { before: activity }
  };
}

function session(runtime = snapshot()): GenerationSession {
  return {
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
        allowedActions: ["back"],
        confirmationRequiredActions: ["back"],
        forbiddenActions: []
      }
    },
    variables: {
      runId: "run-1",
      timestamp: "2026-07-22T12:00:00.000Z",
      randomHex: "a0"
    },
    candidateSteps: [],
    candidateSources: [],
    inFlight: null,
    pendingConfirmation: null,
    verification: { status: "notRun" },
    publication: { status: "notRun" }
  };
}

function harness(confirmResult = true): {
  service: GenerationConfirmationService;
  current: () => GenerationSession;
  mutate: (change: (current: GenerationSession) => GenerationSession) => void;
  confirm: Mock<(
    challenge: PendingConfirmation,
    signal?: AbortSignal
  ) => Promise<boolean>>;
  buildManualProposal: Mock<(
    input: unknown,
    signal?: AbortSignal
  ) => Promise<ProposedStep>>;
  evidence: Map<string, Buffer>;
  setNow: (value: Date) => void;
} {
  let current = session();
  let now = new Date("2026-07-22T12:00:00.000Z");
  const evidence = new Map<string, Buffer>();
  const confirm = vi.fn<(
    challenge: PendingConfirmation,
    signal?: AbortSignal
  ) => Promise<boolean>>(
    () => Promise.resolve(confirmResult)
  );
  const buildManualProposal = vi.fn<(
    input: unknown,
    signal?: AbortSignal
  ) => Promise<ProposedStep>>(
    () => Promise.resolve(proposal())
  );
  const store = {
    read: vi.fn(() => Promise.resolve(current)),
    writeEvidence: vi.fn((
      _id: string,
      path: string,
      value: unknown
    ) => {
      if (evidence.has(path)) {
        return Promise.reject(new Error("evidence already exists"));
      }
      evidence.set(path, Buffer.from(`${JSON.stringify(value)}\n`));
      return Promise.resolve();
    }),
    readEvidence: vi.fn((_id: string, path: string) => {
      const value = evidence.get(path);
      return value === undefined
        ? Promise.reject(new Error("evidence not found"))
        : Promise.resolve(value);
    }),
    updateConfirmation: vi.fn((
      _id: string,
      expectedRevision: number,
      next: GenerationSession
    ) => {
      expect(current.revision).toBe(expectedRevision);
      current = GenerationSessionSchema.parse(next);
      return Promise.resolve();
    })
  };
  return {
    service: new GenerationConfirmationService({
      store,
      prompt: {
        confirm,
        buildManualProposal
      },
      now: () => now,
      generateChallengeId: () => "challenge-1",
      confirmationTtlMs: 30_000
    }),
    current: () => current,
    mutate: (change): void => {
      current = GenerationSessionSchema.parse(change(current));
    },
    confirm,
    buildManualProposal,
    evidence,
    setNow: (value): void => {
      now = value;
    }
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise
  };
}

describe("GenerationConfirmationService", () => {
  it("binds and persists a short-lived exact next-step challenge", async () => {
    const runtime = snapshot();
    const test = harness();
    const result = await test.service.request({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime
    });

    expect(result).toMatchObject({
      status: "confirmationRequired",
      challenge: {
        challengeId: "challenge-1",
        stepIndex: 0,
        snapshotHash: hashRuntimeSnapshot(runtime),
        actionSummary: "Back from com.example.app.MainActivity",
        expiresAt: "2026-07-22T12:00:30.000Z",
        status: "pending"
      }
    });
    expect(result.status).toBe("confirmationRequired");
    if (result.status !== "confirmationRequired") {
      throw new Error("Expected confirmation challenge");
    }
    expect(test.current()).toMatchObject({
      revision: 3,
      pendingConfirmation: result.challenge
    });
  });

  it("confirms only through the local prompt and marks the challenge approved", async () => {
    const runtime = snapshot();
    const test = harness();
    await test.service.request({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime
    });
    const approved = await test.service.confirm({
      generationId: "generation-1",
      challengeId: "challenge-1",
      proposal: proposal(runtime),
      snapshot: runtime
    });

    expect(test.confirm).toHaveBeenCalledTimes(1);
    expect(approved.status).toBe("approved");
    expect(test.current()).toMatchObject({
      revision: 4,
      pendingConfirmation: { status: "approved" }
    });
  });

  it("loads exact immutable Core evidence for cross-process approval", async () => {
    const runtime = snapshot();
    const test = harness();
    await test.service.request({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime,
      source: "manualOverride"
    });

    const approved = await test.service.confirmStored({
      generationId: "generation-1",
      challengeId: "challenge-1"
    });

    expect(approved).toEqual({
      status: "approved",
      proposal: proposal(runtime),
      snapshot: runtime,
      source: "manualOverride"
    });
    expect(test.current()).toMatchObject({
      revision: 4,
      pendingConfirmation: { status: "approved" }
    });
  });

  it("resumes an exact approved challenge without prompting twice", async () => {
    const runtime = snapshot();
    const test = harness();
    await test.service.request({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime
    });
    await test.service.confirmStored({
      generationId: "generation-1",
      challengeId: "challenge-1"
    });

    const resumed = await test.service.confirmStored({
      generationId: "generation-1",
      challengeId: "challenge-1"
    });

    expect(resumed).toMatchObject({
      status: "approved",
      proposal: proposal(runtime),
      source: "planner"
    });
    expect(test.confirm).toHaveBeenCalledTimes(1);
    expect(test.current().pendingConfirmation).toMatchObject({
      challengeId: "challenge-1",
      status: "approved"
    });
  });

  it("aborts an active confirmation prompt without approving the challenge", async () => {
    const runtime = snapshot();
    const test = harness();
    const controller = new AbortController();
    test.confirm.mockImplementationOnce((
      _challenge,
      signal
    ): Promise<boolean> => {
      if (signal === undefined) {
        return Promise.reject(new Error("Missing abort signal"));
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new Error("Generation prompt was cancelled"));
        }, { once: true });
      });
    });
    await test.service.request({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime
    });
    const confirmation = test.service.confirmStored({
      generationId: "generation-1",
      challengeId: "challenge-1",
      signal: controller.signal
    });
    await vi.waitFor(() => {
      expect(test.confirm).toHaveBeenCalledTimes(1);
    });

    controller.abort();

    await expect(confirmation).rejects.toThrow(/cancelled/i);
    expect(test.current().pendingConfirmation).toBeNull();
  });

  it("aborts active manual proposal construction without creating a challenge", async () => {
    const runtime = snapshot();
    const test = harness();
    const controller = new AbortController();
    test.buildManualProposal.mockImplementationOnce((
      _input,
      signal
    ): Promise<ProposedStep> => {
      if (signal === undefined) {
        return Promise.reject(new Error("Missing abort signal"));
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new Error("Generation prompt was cancelled"));
        }, { once: true });
      });
    });
    const manual = test.service.requestManual({
      generationId: "generation-1",
      snapshot: runtime,
      manual: {
        action: "back",
        binding: proposal(runtime).binding,
        before: activity,
        layout: runtime.layout
      },
      signal: controller.signal
    });
    await vi.waitFor(() => {
      expect(test.buildManualProposal).toHaveBeenCalledTimes(1);
    });

    controller.abort();

    await expect(manual).rejects.toThrow(/cancelled/i);
    expect(test.current()).toEqual(session(runtime));
  });

  it("rejects tampered provenance evidence before prompting", async () => {
    const runtime = snapshot();
    const test = harness();
    await test.service.request({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime,
      source: "planner"
    });
    const path = confirmationEvidencePath("challenge-1");
    const stored = JSON.parse(
      test.evidence.get(path)?.toString("utf8") ?? "null"
    ) as Record<string, unknown>;
    test.evidence.set(path, Buffer.from(JSON.stringify({
      ...stored,
      source: "manualOverride"
    })));

    await expect(test.service.confirmStored({
      generationId: "generation-1",
      challengeId: "challenge-1"
    })).rejects.toThrow(/evidence/i);
    expect(test.confirm).not.toHaveBeenCalled();
  });

  it("clears an expired approved challenge without prompting or acting", async () => {
    const runtime = snapshot();
    const test = harness();
    await test.service.request({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime
    });
    await test.service.confirmStored({
      generationId: "generation-1",
      challengeId: "challenge-1"
    });
    test.setNow(new Date("2026-07-22T12:00:31.000Z"));

    await expect(test.service.confirmStored({
      generationId: "generation-1",
      challengeId: "challenge-1"
    })).rejects.toThrow(/expired/i);
    expect(test.confirm).toHaveBeenCalledTimes(1);
    expect(test.current().pendingConfirmation).toBeNull();
  });

  it("decline clears the challenge deterministically", async () => {
    const runtime = snapshot();
    const test = harness(false);
    await test.service.request({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime
    });

    await expect(test.service.confirm({
      generationId: "generation-1",
      challengeId: "challenge-1",
      proposal: proposal(runtime),
      snapshot: runtime
    })).rejects.toThrow(/declined/i);
    expect(test.current().pendingConfirmation).toBeNull();
  });

  it("clears expired challenges without prompting", async () => {
    const runtime = snapshot();
    let current = session(runtime);
    const confirm = vi.fn();
    const evidence = new Map<string, Buffer>();
    const store = {
      read: vi.fn(() => Promise.resolve(current)),
      writeEvidence: vi.fn((
        _id: string,
        path: string,
        value: unknown
      ) => {
        evidence.set(path, Buffer.from(`${JSON.stringify(value)}\n`));
        return Promise.resolve();
      }),
      readEvidence: vi.fn((_id: string, path: string) => {
        const value = evidence.get(path);
        return value === undefined
          ? Promise.reject(new Error("evidence not found"))
          : Promise.resolve(value);
      }),
      updateConfirmation: vi.fn((
        _id: string,
        _revision: number,
        next: GenerationSession
      ) => {
        current = GenerationSessionSchema.parse(next);
        return Promise.resolve();
      })
    };
    const requestService = new GenerationConfirmationService({
      store,
      prompt: {
        confirm,
        buildManualProposal: vi.fn()
      },
      now: (): Date => new Date("2026-07-22T12:00:00.000Z"),
      generateChallengeId: (): string => "challenge-1",
      confirmationTtlMs: 1
    });
    await requestService.request({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime
    });
    const expiredService = new GenerationConfirmationService({
      store,
      prompt: {
        confirm,
        buildManualProposal: vi.fn()
      },
      now: (): Date => new Date("2026-07-22T12:00:00.002Z"),
      generateChallengeId: (): string => "unused",
      confirmationTtlMs: 1
    });

    await expect(expiredService.confirm({
      generationId: "generation-1",
      challengeId: "challenge-1",
      proposal: proposal(runtime),
      snapshot: runtime
    })).rejects.toThrow(/expired/i);
    expect(confirm).not.toHaveBeenCalled();
    expect(current.pendingConfirmation).toBeNull();
  });

  it.each([
    ["proposal change", (value: ProposedStep): ProposedStep => ({
      ...value,
      activity: { before: "com.example.app.OtherActivity" }
    }), "challenge-1"],
    ["challenge mismatch", (value: ProposedStep): ProposedStep => value, "other-challenge"]
  ])("rejects %s and does not allow approval reuse", async (
    _name,
    mutate,
    challengeId
  ) => {
    const runtime = snapshot();
    const test = harness();
    await test.service.request({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime
    });
    await expect(test.service.confirm({
      generationId: "generation-1",
      challengeId,
      proposal: mutate(proposal(runtime)),
      snapshot: runtime
    })).rejects.toThrow();
  });

  it("rejects approval reuse after the exact challenge is consumed", async () => {
    const runtime = snapshot();
    const test = harness();
    await test.service.request({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime
    });
    await test.service.confirm({
      generationId: "generation-1",
      challengeId: "challenge-1",
      proposal: proposal(runtime),
      snapshot: runtime
    });
    test.mutate((current) => {
      const approved = current.pendingConfirmation;
      if (approved === null) {
        throw new Error("Expected approved challenge");
      }
      return {
        ...current,
        revision: current.revision + 1,
        pendingConfirmation: null,
        inFlight: {
          stepIndex: approved.stepIndex,
          proposalHash: approved.proposalHash,
          snapshotHash: approved.snapshotHash,
          attemptId: "attempt-1"
        }
      };
    });

    await expect(test.service.confirm({
      generationId: "generation-1",
      challengeId: "challenge-1",
      proposal: proposal(runtime),
      snapshot: runtime
    })).rejects.toThrow(/no pending/i);
    expect(test.confirm).toHaveBeenCalledTimes(1);
  });

  it("clears the challenge when prompting fails", async () => {
    const runtime = snapshot();
    const test = harness();
    test.confirm.mockRejectedValueOnce(new Error("TTY closed"));
    await test.service.request({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime
    });

    await expect(test.service.confirm({
      generationId: "generation-1",
      challengeId: "challenge-1",
      proposal: proposal(runtime),
      snapshot: runtime
    })).rejects.toThrow(/TTY closed/);
    expect(test.current().pendingConfirmation).toBeNull();
  });

  it("fails closed without clearing after an unrelated revision change", async () => {
    const runtime = snapshot();
    const test = harness();
    await test.service.request({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime
    });
    test.mutate((current) => ({
      ...current,
      revision: current.revision + 1
    }));

    await expect(test.service.confirm({
      generationId: "generation-1",
      challengeId: "challenge-1",
      proposal: proposal(runtime),
      snapshot: runtime
    })).rejects.toThrow(/authoritative/i);
    expect(test.confirm).not.toHaveBeenCalled();
    expect(test.current().pendingConfirmation).toMatchObject({
      challengeId: "challenge-1",
      status: "pending"
    });
  });

  it("revalidates without stale cleanup when state changes during prompting", async () => {
    const runtime = snapshot();
    const test = harness();
    await test.service.request({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime
    });
    test.confirm.mockImplementationOnce((): Promise<boolean> => {
      test.mutate((current) => ({
        ...current,
        revision: current.revision + 1
      }));
      return Promise.resolve(true);
    });

    await expect(test.service.confirm({
      generationId: "generation-1",
      challengeId: "challenge-1",
      proposal: proposal(runtime),
      snapshot: runtime
    })).rejects.toThrow(/changed while prompting/i);
    expect(test.current().pendingConfirmation).toMatchObject({
      challengeId: "challenge-1",
      status: "pending"
    });
  });

  it("routes manual proposals through the same validation and risk pipeline", async () => {
    const runtime = snapshot();
    const test = harness();
    const result = await test.service.requestManual({
      generationId: "generation-1",
      snapshot: runtime,
      manual: {
        action: "back",
        binding: proposal(runtime).binding,
        before: activity,
        layout: runtime.layout
      }
    });

    expect(test.buildManualProposal).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("confirmationRequired");

    const malformed = harness();
    malformed.buildManualProposal.mockResolvedValueOnce({
      ...proposal(runtime),
      binding: {
        ...proposal(runtime).binding,
        snapshotHash: "f".repeat(64)
      }
    });
    await expect(malformed.service.requestManual({
      generationId: "generation-1",
      snapshot: runtime,
      manual: {
        action: "back",
        binding: proposal(runtime).binding,
        before: activity,
        layout: runtime.layout
      }
    })).rejects.toThrow();
  });

  it.each(["decline", "failure"] as const)(
    "does not let competing %s cleanup clear an approved challenge",
    async (outcome) => {
      const runtime = snapshot();
      const firstPrompt = deferred<boolean>();
      const secondPrompt = deferred<boolean>();
      const test = harness();
      test.confirm.mockReset();
      test.confirm
        .mockImplementationOnce(() => firstPrompt.promise)
        .mockImplementationOnce(() => secondPrompt.promise);
      await test.service.request({
        generationId: "generation-1",
        proposal: proposal(runtime),
        snapshot: runtime
      });

      const first = test.service.confirm({
        generationId: "generation-1",
        challengeId: "challenge-1",
        proposal: proposal(runtime),
        snapshot: runtime
      });
      const second = test.service.confirm({
        generationId: "generation-1",
        challengeId: "challenge-1",
        proposal: proposal(runtime),
        snapshot: runtime
      });
      await vi.waitFor(() => {
        expect(test.confirm).toHaveBeenCalledTimes(2);
      });
      firstPrompt.resolve(true);
      await expect(first).resolves.toMatchObject({ status: "approved" });
      if (outcome === "decline") {
        secondPrompt.resolve(false);
      } else {
        secondPrompt.reject(new Error("TTY failed"));
      }

      await expect(second).rejects.toThrow();
      expect(test.current().pendingConfirmation).toMatchObject({
        challengeId: "challenge-1",
        status: "approved"
      });
    }
  );

  it("allows only one of two concurrent approvals to persist", async () => {
    const runtime = snapshot();
    const firstPrompt = deferred<boolean>();
    const secondPrompt = deferred<boolean>();
    const test = harness();
    test.confirm.mockReset();
    test.confirm
      .mockImplementationOnce(() => firstPrompt.promise)
      .mockImplementationOnce(() => secondPrompt.promise);
    await test.service.request({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime
    });

    const attempts = [
      test.service.confirm({
        generationId: "generation-1",
        challengeId: "challenge-1",
        proposal: proposal(runtime),
        snapshot: runtime
      }),
      test.service.confirm({
        generationId: "generation-1",
        challengeId: "challenge-1",
        proposal: proposal(runtime),
        snapshot: runtime
      })
    ];
    await vi.waitFor(() => {
      expect(test.confirm).toHaveBeenCalledTimes(2);
    });
    firstPrompt.resolve(true);
    await expect(attempts[0]).resolves.toMatchObject({ status: "approved" });
    secondPrompt.resolve(true);
    const second = await Promise.allSettled([attempts[1]]);

    expect(second[0].status).toBe("rejected");
    expect(test.current().pendingConfirmation).toMatchObject({
      challengeId: "challenge-1",
      status: "approved"
    });
  });

  it("does not let stale prompt cleanup clear a replacement challenge", async () => {
    const runtime = snapshot();
    const promptResult = deferred<boolean>();
    const test = harness();
    test.confirm.mockReset();
    test.confirm.mockImplementationOnce(() => promptResult.promise);
    await test.service.request({
      generationId: "generation-1",
      proposal: proposal(runtime),
      snapshot: runtime
    });
    const confirmation = test.service.confirm({
      generationId: "generation-1",
      challengeId: "challenge-1",
      proposal: proposal(runtime),
      snapshot: runtime
    });
    await vi.waitFor(() => {
      expect(test.confirm).toHaveBeenCalledTimes(1);
    });
    test.mutate((current) => {
      const pending = current.pendingConfirmation;
      if (pending === null) {
        throw new Error("Expected pending confirmation");
      }
      return {
        ...current,
        revision: current.revision + 1,
        pendingConfirmation: {
          ...pending,
          proposalHash: "d".repeat(64)
        }
      };
    });
    promptResult.reject(new Error("TTY failed"));

    await expect(confirmation).rejects.toThrow(/TTY failed/);
    expect(test.current().pendingConfirmation).toMatchObject({
      challengeId: "challenge-1",
      proposalHash: "d".repeat(64),
      status: "pending"
    });
  });
});
