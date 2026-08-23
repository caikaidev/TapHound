import { describe, expect, it, vi } from "vitest";

import {
  GenerationRecoveryService
} from "../../../src/application/generation/generation-recovery-service.js";
import type {
  GenerationSession
} from "../../../src/domain/generation.js";
import {
  GenerationSessionStoreError
} from "../../../src/ports/generation-session-store.js";

function session(
  overrides: Partial<GenerationSession> = {}
): GenerationSession {
  return {
    version: 1,
    id: "generation-1",
    revision: 2,
    state: "active",
    bindings: {
      projectHash: "a".repeat(64),
      configHash: "b".repeat(64),
      contextHash: "c".repeat(64),
      snapshotHash: "d".repeat(64)
    },
    target: {
      packageName: "com.example.app",
      deviceSerial: "emulator-5554",
      resetStrategy: "processOnly",
      interactionPolicy: {
        allowedActions: ["click"],
        confirmationRequiredActions: [],
        forbiddenActions: []
      }
    },
    contextSelection: {
      bundleVersion: 2,
      indexHash: "e".repeat(64),
      modules: [{
        id: ":app",
        sha256: "f".repeat(64),
        projectDir: "app",
        inventory: {
          pathSetSha256: "1".repeat(64),
          categories: ["sources"]
        }
      }]
    },
    variables: {
      runId: "run-1",
      timestamp: "2026-08-20T00:00:00.000Z",
      randomHex: "c0ffee"
    },
    candidateSteps: [],
    candidateSources: [],
    inFlight: null,
    pendingConfirmation: null,
    verification: { status: "notRun" },
    publication: { status: "notRun" },
    externalFlows: [],
    ...overrides
  };
}

function harness(initial: GenerationSession, ownerAlive = false): {
  service: GenerationRecoveryService;
  current: () => GenerationSession;
  recover: ReturnType<typeof vi.fn>;
  recoverVerification: ReturnType<typeof vi.fn>;
} {
  let current = initial;
  const recover = vi.fn((
    _id: string,
    _revision: number,
    next: GenerationSession
  ) => {
    current = next;
    return Promise.resolve();
  });
  const recoverVerification = vi.fn((
    _id: string,
    _revision: number,
    next: GenerationSession
  ) => {
    current = next;
    return Promise.resolve();
  });
  return {
    service: new GenerationRecoveryService({
      store: {
        read: () => Promise.resolve(current),
        readEvidence: () => Promise.reject(
          new GenerationSessionStoreError(
            "EVIDENCE_NOT_FOUND",
            "missing"
          )
        ),
        recover,
        recoverVerification
      },
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      ownerAlive: () => ownerAlive
    }),
    current: () => current,
    recover,
    recoverVerification
  };
}

describe("GenerationRecoveryService", () => {
  it("exposes an expired pending confirmation without treating it as recovery", async () => {
    const test = harness(session({
      pendingConfirmation: {
        challengeId: "challenge-1",
        stepIndex: 0,
        proposalHash: "a".repeat(64),
        snapshotHash: "d".repeat(64),
        evidenceHash: "b".repeat(64),
        actionSummary: "click send",
        expiresAt: "2026-08-20T11:59:59.000Z",
        status: "pending"
      }
    }));

    await expect(test.service.status("generation-1")).resolves.toMatchObject({
      pendingConfirmation: {
        challengeId: "challenge-1",
        expired: true
      },
      recovery: { available: false }
    });
  });

  it("reactivates an explicitly retried interrupted step", async () => {
    const inFlight = {
      stepIndex: 0,
      snapshotHash: "d".repeat(64),
      proposalHash: "f".repeat(64),
      attemptId: "attempt-1"
    };
    const test = harness(session({
      state: "recoveryRequired",
      inFlight
    }));

    await expect(test.service.status("generation-1")).resolves.toMatchObject({
      recovery: {
        available: true,
        kind: "step",
        actionMayHaveExecuted: true,
        requiredDecision: "retry"
      }
    });
    await test.service.retry("generation-1");

    expect(test.recover).toHaveBeenCalledOnce();
    expect(test.current()).toMatchObject({
      revision: 3,
      state: "active",
      inFlight: null
    });
  });

  it("resets a dead verification owner only after explicit retry", async () => {
    const test = harness(session({
      verification: {
        status: "running",
        attemptId: "attempt-1",
        ownerPid: 1234,
        startedAt: "2026-08-20T00:00:00.000Z"
      }
    }));

    await expect(test.service.status("generation-1")).resolves.toMatchObject({
      recovery: {
        available: true,
        kind: "verification",
        ownerAlive: false
      }
    });
    await test.service.retry("generation-1");

    expect(test.recoverVerification).toHaveBeenCalledOnce();
    expect(test.current().verification).toEqual({ status: "notRun" });
  });

  it("does not offer verification takeover while the owner is alive", async () => {
    const test = harness(session({
      verification: {
        status: "running",
        attemptId: "attempt-1",
        ownerPid: 1234,
        startedAt: "2026-08-20T00:00:00.000Z"
      }
    }), true);

    await expect(test.service.status("generation-1")).resolves.toMatchObject({
      recovery: {
        available: false,
        kind: null,
        ownerAlive: true
      }
    });
    await expect(test.service.retry("generation-1")).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED"
    });
  });
});
