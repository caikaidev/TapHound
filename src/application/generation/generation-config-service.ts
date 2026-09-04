import {
  GenerationSessionSchema,
  type GenerationSession
} from "../../domain/generation.js";
import { IdlePolicySchema, type TapHoundConfig } from "../../domain/config.js";
import type { GenerationSessionStore } from "../../ports/generation-session-store.js";
import { GenerationOperationError } from "./generation-starter.js";

export interface GenerationIdlePolicyPatch {
  strategy?: TapHoundConfig["idle"]["strategy"] | undefined;
  pollIntervalMs?: number | undefined;
  stablePolls?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface GenerationConfigServiceDependencies {
  store: Pick<GenerationSessionStore, "read" | "update">;
}

function hasPatch(patch: GenerationIdlePolicyPatch): boolean {
  return patch.strategy !== undefined
    || patch.pollIntervalMs !== undefined
    || patch.stablePolls !== undefined
    || patch.timeoutMs !== undefined;
}

function assertUpdatable(session: GenerationSession): void {
  if (session.state !== "active") {
    throw new GenerationOperationError(
      "CONFIG_INVALID",
      `Generation idle policy can only be updated on an active session (state: ${session.state})`
    );
  }
  if (session.inFlight !== null) {
    throw new GenerationOperationError(
      "CONFIG_INVALID",
      "Generation idle policy cannot change while a step is in flight"
    );
  }
  if (session.pendingConfirmation !== null) {
    throw new GenerationOperationError(
      "CONFIG_INVALID",
      "Generation idle policy cannot change while a confirmation is pending"
    );
  }
  if (session.verification.status !== "notRun") {
    throw new GenerationOperationError(
      "CONFIG_INVALID",
      "Generation idle policy cannot change once verification has started"
    );
  }
  if (session.publication.status !== "notRun") {
    throw new GenerationOperationError(
      "CONFIG_INVALID",
      "Generation idle policy cannot change after publication"
    );
  }
}

export class GenerationConfigService {
  public constructor(
    private readonly dependencies: GenerationConfigServiceDependencies
  ) {}

  public readonly updateIdlePolicy = async (
    input: {
      generationId: string;
      config: TapHoundConfig;
      patch: GenerationIdlePolicyPatch;
    }
  ): Promise<GenerationSession> => {
    if (!hasPatch(input.patch)) {
      throw new GenerationOperationError(
        "CONFIG_INVALID",
        "Generation idle policy update requires at least one setting"
      );
    }
    const session = GenerationSessionSchema.parse(
      await this.dependencies.store.read(input.generationId)
    );
    assertUpdatable(session);
    const base = session.idlePolicy ?? input.config.idle;
    const idlePolicy = IdlePolicySchema.parse({
      strategy: input.patch.strategy ?? base.strategy,
      pollIntervalMs: input.patch.pollIntervalMs ?? base.pollIntervalMs,
      stablePolls: input.patch.stablePolls ?? base.stablePolls,
      timeoutMs: input.patch.timeoutMs ?? base.timeoutMs
    });
    const next: GenerationSession = {
      ...session,
      revision: session.revision + 1,
      idlePolicy
    };
    await this.dependencies.store.update(
      input.generationId,
      session.revision,
      next
    );
    return next;
  };
}
