import { describe, expect, it, vi, type Mock } from "vitest";

import {
  GenerationConfirmationService
} from "../../../src/application/generation/generation-confirmation-service.js";
import {
  GenerationSessionSchema,
  type GenerationSession
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
  confirm: Mock<() => Promise<boolean>>;
  buildManualProposal: Mock<() => Promise<ProposedStep>>;
} {
  let current = session();
  const confirm = vi.fn<() => Promise<boolean>>(
    () => Promise.resolve(confirmResult)
  );
  const buildManualProposal = vi.fn<() => Promise<ProposedStep>>(
    () => Promise.resolve(proposal())
  );
  const store = {
    read: vi.fn(() => Promise.resolve(current)),
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
      now: () => new Date("2026-07-22T12:00:00.000Z"),
      generateChallengeId: () => "challenge-1",
      confirmationTtlMs: 30_000
    }),
    current: () => current,
    mutate: (change): void => {
      current = GenerationSessionSchema.parse(change(current));
    },
    confirm,
    buildManualProposal
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
    const store = {
      read: vi.fn(() => Promise.resolve(current)),
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
    ["challenge replay", (value: ProposedStep): ProposedStep => value, "challenge-1"],
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
    if (_name === "challenge replay") {
      await test.service.confirm({
        generationId: "generation-1",
        challengeId,
        proposal: proposal(runtime),
        snapshot: runtime
      });
    }
    await expect(test.service.confirm({
      generationId: "generation-1",
      challengeId,
      proposal: mutate(proposal(runtime)),
      snapshot: runtime
    })).rejects.toThrow();
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

  it("invalidates a challenge after an unrelated session revision change", async () => {
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
    expect(test.current().pendingConfirmation).toBeNull();
  });

  it("revalidates and clears state changed while the local prompt is open", async () => {
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
    expect(test.current().pendingConfirmation).toBeNull();
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
});
