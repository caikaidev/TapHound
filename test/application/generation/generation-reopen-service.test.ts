import { describe, expect, it, vi } from "vitest";

import {
  GenerationReopenService
} from "../../../src/application/generation/generation-reopen-service.js";
import {
  GenerationSessionSchema,
  type GenerationSession
} from "../../../src/domain/generation.js";
import { contextSelection } from "../../fixtures/project-context.js";
import { TEST_UI_BACKEND } from "../../fakes/ui-backend.js";

function failedSession(): GenerationSession {
  return GenerationSessionSchema.parse({
    version: 1,
    id: "generation-1",
    revision: 4,
    state: "active",
    bindings: {
      projectHash: "a".repeat(64),
      configHash: "b".repeat(64),
      contextHash: "c".repeat(64),
      snapshotHash: "d".repeat(64),
      uiBackend: TEST_UI_BACKEND
    },
    target: {
      packageName: "com.example.app",
      deviceSerial: "emulator-5554",
      resetStrategy: "processOnly",
      interactionPolicy: {
        allowedActions: ["click", "wait"],
        confirmationRequiredActions: [],
        forbiddenActions: []
      }
    },
    contextSelection,
    variables: {
      runId: "run-1",
      timestamp: "2026-09-16T00:00:00.000Z",
      randomHex: "abc123"
    },
    externalFlows: [],
    candidateSteps: [],
    candidateSources: [],
    inFlight: null,
    pendingConfirmation: null,
    verification: {
      status: "failed",
      failure: {
        code: "VERIFICATION_FAILED",
        message: "step 0 locator missing"
      }
    },
    publication: { status: "notRun" },
    verificationHistory: []
  });
}

describe("GenerationReopenService", () => {
  it("atomically preserves the failed attempt before reopening repairs", async () => {
    let current = failedSession();
    const reopenVerification = vi.fn((
      _id: string,
      _revision: number,
      next: GenerationSession
    ): Promise<void> => {
      current = next;
      return Promise.resolve();
    });
    const service = new GenerationReopenService({
      store: {
        read: (): Promise<GenerationSession> => Promise.resolve(current),
        reopenVerification
      },
      now: (): Date => new Date("2026-09-16T08:00:00.000Z")
    });

    const result = await service.reopen({
      generationId: "generation-1",
      reason: "add late-render guard"
    });

    expect(reopenVerification).toHaveBeenCalledWith(
      "generation-1",
      4,
      expect.objectContaining({ revision: 5 })
    );
    expect(result).toMatchObject({
      revision: 5,
      verification: { status: "notRun" },
      verificationHistory: [{
        failedRevision: 4,
        reopenedAt: "2026-09-16T08:00:00.000Z",
        reason: "add late-render guard",
        failure: {
          code: "VERIFICATION_FAILED",
          message: "step 0 locator missing"
        }
      }]
    });
  });

  it("rejects reopening a session without failed verification", async () => {
    const current = GenerationSessionSchema.parse({
      ...failedSession(),
      verification: { status: "notRun" }
    });
    const service = new GenerationReopenService({
      store: {
        read: (): Promise<GenerationSession> => Promise.resolve(current),
        reopenVerification: vi.fn()
      },
      now: (): Date => new Date("2026-09-16T08:00:00.000Z")
    });

    await expect(service.reopen({
      generationId: "generation-1",
      reason: "not applicable"
    })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
