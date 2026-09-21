import { z } from "zod";

import {
  GenerationSessionSchema,
  type GenerationSession
} from "../../domain/generation.js";
import type {
  GenerationSessionStore
} from "../../ports/generation-session-store.js";
import { GenerationOperationError } from "./generation-starter.js";

export interface GenerationReopenInput {
  generationId: string;
  reason: string;
}

export interface GenerationReopenDependencies {
  store: Pick<
    GenerationSessionStore,
    "read" | "reopenVerification"
  >;
  now: () => Date;
}

const ReopenReasonSchema = z.string().trim().min(1).max(500);

export class GenerationReopenService {
  public constructor(
    private readonly dependencies: GenerationReopenDependencies
  ) {}

  public readonly reopen = async (
    input: GenerationReopenInput
  ): Promise<GenerationSession> => {
    const reason = ReopenReasonSchema.parse(input.reason);
    const current = GenerationSessionSchema.parse(
      await this.dependencies.store.read(input.generationId)
    );
    if (
      current.state !== "active"
      || current.inFlight !== null
      || current.pendingConfirmation !== null
      || current.verification.status !== "failed"
      || current.publication.status !== "notRun"
    ) {
      throw new GenerationOperationError(
        "CONFIG_INVALID",
        "Only an idle active session with failed verification and no publication can be reopened"
      );
    }
    const next = GenerationSessionSchema.parse({
      ...current,
      revision: current.revision + 1,
      verification: { status: "notRun" },
      verificationHistory: [
        ...(current.verificationHistory ?? []),
        {
          failedRevision: current.revision,
          reopenedAt: this.dependencies.now().toISOString(),
          reason,
          failure: current.verification.failure
        }
      ]
    });
    await this.dependencies.store.reopenVerification(
      current.id,
      current.revision,
      next
    );
    return next;
  };
}
