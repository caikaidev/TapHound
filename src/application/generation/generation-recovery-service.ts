import { z } from "zod";

import {
  GenerationSessionSchema,
  isGenerationConfirmationExpired,
  type GenerationSession
} from "../../domain/generation.js";
import {
  GenerationSessionStoreError,
  type GenerationSessionStore
} from "../../ports/generation-session-store.js";
import { GenerationOperationError } from "./generation-starter.js";

const AttemptOutcomeSchema = z.looseObject({
  status: z.enum(["succeeded", "failed", "cancelled"])
});

export interface GenerationRecoveryStatus {
  generationId: string;
  revision: number;
  state: GenerationSession["state"];
  candidateStepCount: number;
  inFlight: GenerationSession["inFlight"];
  pendingConfirmation: (
    & NonNullable<GenerationSession["pendingConfirmation"]>
    & { expired: boolean }
  ) | null;
  verification: GenerationSession["verification"];
  publication: GenerationSession["publication"];
  recovery: {
    available: boolean;
    kind: "step" | "verification" | null;
    actionMayHaveExecuted: boolean;
    attemptOutcome: "succeeded" | "failed" | "cancelled" | "unknown" | null;
    requiredDecision: "retry" | null;
    ownerAlive: boolean | null;
  };
}

export interface GenerationRecoveryDependencies {
  store: Pick<
    GenerationSessionStore,
    "read" | "readEvidence" | "recover" | "recoverVerification"
  >;
  ownerAlive?: ((pid: number) => boolean) | undefined;
  now: () => Date;
}

function resultPath(session: GenerationSession): string | undefined {
  const inFlight = session.inFlight;
  return inFlight === null
    ? undefined
    : `evidence/steps/${String(inFlight.stepIndex)}-${
        inFlight.attemptId
      }/result.json`;
}

export class GenerationRecoveryService {
  public constructor(
    private readonly dependencies: GenerationRecoveryDependencies
  ) {}

  public readonly status = async (
    generationId: string
  ): Promise<GenerationRecoveryStatus> => {
    const session = GenerationSessionSchema.parse(
      await this.dependencies.store.read(generationId)
    );
    const path = resultPath(session);
    let attemptOutcome:
      | "succeeded"
      | "failed"
      | "cancelled"
      | "unknown"
      | null = null;
    if (path !== undefined) {
      try {
        const bytes = await this.dependencies.store.readEvidence(
          session.id,
          path
        );
        const parsed = z.looseObject({
          outcome: AttemptOutcomeSchema
        }).parse(JSON.parse(bytes.toString("utf8")) as unknown);
        attemptOutcome = parsed.outcome.status;
      } catch (error) {
        if (
          error instanceof GenerationSessionStoreError
          && error.code === "EVIDENCE_NOT_FOUND"
        ) {
          attemptOutcome = "unknown";
        } else if (error instanceof SyntaxError || error instanceof z.ZodError) {
          attemptOutcome = "unknown";
        } else {
          throw error;
        }
      }
    }
    const stepAvailable = session.state === "recoveryRequired"
      && session.inFlight !== null
      && session.verification.status === "notRun"
      && session.publication.status === "notRun";
    const verificationMayRecover = session.state === "active"
      && session.inFlight === null
      && session.verification.status === "running"
      && session.publication.status === "notRun";
    const [hasReceipt, hasReport] = verificationMayRecover
      ? await Promise.all([
          this.evidenceExists(session.id, "verification/receipt.json"),
          this.evidenceExists(session.id, "verification/report.json")
        ])
      : [false, false];
    const verificationOwnerAlive = session.verification.status === "running"
      && session.verification.ownerPid !== undefined
      ? (this.dependencies.ownerAlive?.(session.verification.ownerPid) ?? null)
      : null;
    const verificationAvailable = verificationMayRecover
      && verificationOwnerAlive !== true
      && !hasReceipt
      && !hasReport;
    const available = stepAvailable || verificationAvailable;
    return {
      generationId: session.id,
      revision: session.revision,
      state: session.state,
      candidateStepCount: session.candidateSteps.length,
      inFlight: session.inFlight,
      pendingConfirmation: session.pendingConfirmation === null
        ? null
        : {
            ...session.pendingConfirmation,
            expired: isGenerationConfirmationExpired(
              session.pendingConfirmation,
              this.dependencies.now()
            )
          },
      verification: session.verification,
      publication: session.publication,
      recovery: {
        available,
        kind: stepAvailable
          ? "step"
          : verificationAvailable ? "verification" : null,
        actionMayHaveExecuted: session.inFlight !== null
          || session.verification.status === "running",
        attemptOutcome,
        requiredDecision: available ? "retry" : null,
        ownerAlive: verificationOwnerAlive
      }
    };
  };

  public readonly retry = async (
    generationId: string
  ): Promise<GenerationSession> => {
    const session = GenerationSessionSchema.parse(
      await this.dependencies.store.read(generationId)
    );
    if (
      session.state === "recoveryRequired"
      && session.inFlight !== null
      && session.verification.status === "notRun"
      && session.publication.status === "notRun"
    ) {
      const next = GenerationSessionSchema.parse({
        ...session,
        revision: session.revision + 1,
        state: "active",
        inFlight: null
      });
      await this.dependencies.store.recover(
        session.id,
        session.revision,
        next
      );
      return next;
    }
    if (
      session.state === "active"
      && session.inFlight === null
      && session.verification.status === "running"
      && session.publication.status === "notRun"
      && (
        session.verification.ownerPid === undefined
        || this.dependencies.ownerAlive?.(session.verification.ownerPid)
          !== true
      )
      && !await this.evidenceExists(session.id, "verification/receipt.json")
      && !await this.evidenceExists(session.id, "verification/report.json")
    ) {
      const next = GenerationSessionSchema.parse({
        ...session,
        revision: session.revision + 1,
        verification: { status: "notRun" }
      });
      await this.dependencies.store.recoverVerification(
        session.id,
        session.revision,
        next
      );
      return next;
    }
    throw new GenerationOperationError(
      "RECOVERY_REQUIRED",
      "Session recovery is unavailable or immutable verification evidence already exists"
    );
  };

  private async evidenceExists(
    generationId: string,
    path: string
  ): Promise<boolean> {
    try {
      await this.dependencies.store.readEvidence(generationId, path);
      return true;
    } catch (error) {
      if (
        error instanceof GenerationSessionStoreError
        && error.code === "EVIDENCE_NOT_FOUND"
      ) {
        return false;
      }
      throw error;
    }
  }
}
