import {
  GenerationConfirmationEvidenceSchema,
  GenerationSessionIdSchema,
  GenerationSessionSchema,
  type GenerationConfirmationEvidence,
  type PendingConfirmation
} from "../../domain/generation.js";
import {
  ProposedStepSchema,
  hashProposedStep,
  type ProposedStep
} from "../../domain/proposed-step.js";
import {
  RuntimeSnapshotSchema,
  hashRuntimeSnapshot,
  type RuntimeSnapshot
} from "../../domain/runtime-snapshot.js";
import type { GenerationPromptPort } from "../../ports/generation-prompt.js";
import type { ManualProposalInput } from "../../ports/generation-prompt.js";
import type {
  GenerationSessionStore
} from "../../ports/generation-session-store.js";
import { GenerationOperationError } from "./generation-starter.js";
import { ProposedStepValidator } from "./proposed-step-validator.js";
import { RiskEvaluator } from "./risk-evaluator.js";

export interface GenerationConfirmationDependencies {
  store: Pick<
    GenerationSessionStore,
    "read" | "updateConfirmation" | "writeEvidence" | "readEvidence"
  >;
  prompt: Pick<
    GenerationPromptPort,
    "confirm" | "buildManualProposal"
  >;
  now: () => Date;
  generateChallengeId: () => string;
  confirmationTtlMs: number;
}

export interface ConfirmationRequestInput {
  generationId: string;
  proposal: ProposedStep;
  snapshot: RuntimeSnapshot;
  source?: "planner" | "manualOverride" | undefined;
}

export interface ConfirmationApproveInput extends ConfirmationRequestInput {
  challengeId: string;
}

export interface StoredConfirmationApproveInput {
  generationId: string;
  challengeId: string;
}

export interface ManualConfirmationRequestInput {
  generationId: string;
  snapshot: RuntimeSnapshot;
  manual: ManualProposalInput;
}

export type ConfirmationRequestResult =
  | { status: "approved"; proposal: ProposedStep }
  | {
    status: "confirmationRequired";
    challenge: PendingConfirmation;
  };

export interface StoredConfirmationApproveResult {
  status: "approved";
  proposal: ProposedStep;
  snapshot: RuntimeSnapshot;
  source: "planner" | "manualOverride";
}

interface PendingChallengeToken {
  expectedRevision: number;
  expectedChallenge: PendingConfirmation;
}

function locatorSummary(step: ProposedStep): string {
  if (
    step.action === "inputText"
    || step.action === "back"
    || step.action === "wait"
  ) {
    return "";
  }
  return JSON.stringify(step.locator);
}

export function summarizeProposedStep(step: ProposedStep): string {
  const before = step.activity.before;
  if (step.action === "back") {
    return `Back from ${before}`;
  }
  if (step.action === "wait") {
    return `Wait on ${before}`;
  }
  if (step.action === "inputText") {
    return `Input text on focused element in ${before}`;
  }
  if (step.action === "scrollTo") {
    return `Scroll ${step.direction} in ${JSON.stringify(
      step.container
    )} to ${locatorSummary(step)} on ${before}`;
  }
  return `${step.action} ${locatorSummary(step)} on ${before}`;
}

function bindingFailure(message: string): GenerationOperationError {
  return new GenerationOperationError(
    "RISK_CONFIRMATION_REQUIRED",
    message
  );
}

export function confirmationEvidencePath(challengeId: string): string {
  return `evidence/confirmations/${
    GenerationSessionIdSchema.parse(challengeId)
  }.json`;
}

export class GenerationConfirmationService {
  private readonly validator = new ProposedStepValidator();
  private readonly riskEvaluator = new RiskEvaluator();

  public constructor(
    private readonly dependencies: GenerationConfirmationDependencies
  ) {
    if (
      !Number.isSafeInteger(dependencies.confirmationTtlMs)
      || dependencies.confirmationTtlMs <= 0
    ) {
      throw new Error("Confirmation TTL must be a positive safe integer");
    }
  }

  public readonly request = async (
    input: ConfirmationRequestInput
  ): Promise<ConfirmationRequestResult> => {
    const session = GenerationSessionSchema.parse(
      await this.dependencies.store.read(input.generationId)
    );
    const proposal = this.validator.validate({
      session,
      snapshot: input.snapshot,
      proposal: input.proposal
    });
    const risk = this.riskEvaluator.evaluate(
      proposal.action,
      session.target.interactionPolicy
    );
    if (risk.effectiveRisk === "forbidden") {
      throw new GenerationOperationError(
        "ACTION_FORBIDDEN",
        `${proposal.action} is forbidden by the Core interaction policy`
      );
    }
    if (risk.effectiveRisk === "safe") {
      return { status: "approved", proposal };
    }
    if (session.revision === Number.MAX_SAFE_INTEGER) {
      throw bindingFailure("Generation revision cannot create a challenge");
    }

    const challenge = {
      challengeId: this.dependencies.generateChallengeId(),
      stepIndex: session.candidateSteps.length,
      proposalHash: hashProposedStep(proposal),
      snapshotHash: proposal.binding.snapshotHash,
      actionSummary: summarizeProposedStep(proposal),
      expiresAt: new Date(
        this.dependencies.now().getTime()
          + this.dependencies.confirmationTtlMs
      ).toISOString(),
      status: "pending" as const
    };
    const next = GenerationSessionSchema.parse({
      ...session,
      revision: session.revision + 1,
      pendingConfirmation: challenge
    });
    const evidence = GenerationConfirmationEvidenceSchema.parse({
      version: 1,
      proposal,
      snapshot: input.snapshot,
      source: input.source ?? "planner"
    });
    await this.dependencies.store.writeEvidence(
      session.id,
      confirmationEvidencePath(challenge.challengeId),
      evidence
    );
    await this.dependencies.store.updateConfirmation(
      session.id,
      session.revision,
      next
    );
    return { status: "confirmationRequired", challenge };
  };

  public readonly requestManual = async (
    input: ManualConfirmationRequestInput
  ): Promise<ConfirmationRequestResult> => {
    const proposal = await this.dependencies.prompt.buildManualProposal(
      input.manual
    );
    return this.request({
      generationId: input.generationId,
      proposal,
      snapshot: input.snapshot,
      source: "manualOverride"
    });
  };

  public readonly confirmStored = async (
    input: StoredConfirmationApproveInput
  ): Promise<StoredConfirmationApproveResult> => {
    const evidence = await this.readStoredEvidence(input);
    await this.confirm({
      generationId: input.generationId,
      challengeId: input.challengeId,
      proposal: evidence.proposal,
      snapshot: evidence.snapshot,
      source: evidence.source
    });
    return {
      status: "approved",
      proposal: evidence.proposal,
      snapshot: evidence.snapshot,
      source: evidence.source
    };
  };

  public readonly confirm = async (
    input: ConfirmationApproveInput
  ): Promise<{ status: "approved"; proposal: ProposedStep }> => {
    const session = GenerationSessionSchema.parse(
      await this.dependencies.store.read(input.generationId)
    );
    const proposal = ProposedStepSchema.parse(input.proposal);
    const snapshot = RuntimeSnapshotSchema.parse(input.snapshot);
    const challenge = session.pendingConfirmation;
    if (challenge === null) {
      throw bindingFailure("No pending generation confirmation exists");
    }
    if (challenge.status !== "pending") {
      throw bindingFailure("Generation confirmation was already used");
    }
    const cleanupToken: PendingChallengeToken = {
      expectedRevision: proposal.binding.baseRevision + 1,
      expectedChallenge: {
        ...challenge,
        challengeId: input.challengeId,
        proposalHash: hashProposedStep(proposal),
        snapshotHash: hashRuntimeSnapshot(snapshot),
        status: "pending"
      }
    };

    const expired = this.dependencies.now().getTime()
      >= new Date(challenge.expiresAt).getTime();
    const challengeMatches = challenge.challengeId === input.challengeId;
    const proposalMatches = challenge.proposalHash
      === hashProposedStep(proposal);
    const snapshotMatches = challenge.snapshotHash
      === hashRuntimeSnapshot(snapshot)
      && challenge.snapshotHash === proposal.binding.snapshotHash
      && challenge.snapshotHash === session.bindings.snapshotHash;
    const stateMatches = session.state === "active"
      && session.inFlight === null
      && session.verification.status === "notRun"
      && session.publication.status === "notRun"
      && session.revision === proposal.binding.baseRevision + 1
      && challenge.stepIndex === session.candidateSteps.length
      && challenge.actionSummary === summarizeProposedStep(proposal);

    if (
      expired
      || !challengeMatches
      || !proposalMatches
      || !snapshotMatches
      || !stateMatches
    ) {
      await this.clearPendingChallenge(session.id, cleanupToken);
      if (expired) {
        throw bindingFailure("Generation confirmation challenge expired");
      }
      throw bindingFailure(
        "Generation confirmation binding is no longer authoritative"
      );
    }

    try {
      const validationSession = GenerationSessionSchema.parse({
        ...session,
        revision: proposal.binding.baseRevision,
        pendingConfirmation: null
      });
      this.validator.validate({
        session: validationSession,
        snapshot,
        proposal
      });
    } catch {
      await this.clearPendingChallenge(session.id, cleanupToken);
      throw bindingFailure(
        "Generation proposal or runtime state changed before confirmation"
      );
    }

    let confirmed: boolean;
    try {
      confirmed = await this.dependencies.prompt.confirm(challenge);
    } catch (error) {
      await this.clearPendingChallenge(session.id, cleanupToken);
      throw error;
    }
    if (!confirmed) {
      await this.clearPendingChallenge(session.id, cleanupToken);
      throw bindingFailure("Generation action confirmation was declined");
    }

    const latest = GenerationSessionSchema.parse(
      await this.dependencies.store.read(input.generationId)
    );
    const stillAuthoritative = latest.revision === session.revision
      && JSON.stringify(latest.pendingConfirmation)
        === JSON.stringify(challenge)
      && this.dependencies.now().getTime()
        < new Date(challenge.expiresAt).getTime();
    if (!stillAuthoritative) {
      await this.clearPendingChallenge(session.id, cleanupToken);
      throw bindingFailure(
        "Generation confirmation state changed while prompting"
      );
    }
    if (latest.revision === Number.MAX_SAFE_INTEGER) {
      await this.clearPendingChallenge(session.id, cleanupToken);
      throw bindingFailure("Generation revision cannot approve challenge");
    }
    const approved = GenerationSessionSchema.parse({
      ...latest,
      revision: latest.revision + 1,
      pendingConfirmation: {
        ...challenge,
        status: "approved"
      }
    });
    await this.dependencies.store.updateConfirmation(
      latest.id,
      latest.revision,
      approved
    );
    return { status: "approved", proposal };
  };

  private async clearPendingChallenge(
    generationId: string,
    token: PendingChallengeToken
  ): Promise<void> {
    const latest = GenerationSessionSchema.parse(
      await this.dependencies.store.read(generationId)
    );
    const pending = latest.pendingConfirmation;
    if (
      latest.revision !== token.expectedRevision
      || pending === null
      || pending.status !== "pending"
      || JSON.stringify(pending) !== JSON.stringify(token.expectedChallenge)
    ) {
      return;
    }
    if (latest.revision === Number.MAX_SAFE_INTEGER) {
      throw bindingFailure("Generation revision cannot clear challenge");
    }
    const cleared = GenerationSessionSchema.parse({
      ...latest,
      revision: latest.revision + 1,
      pendingConfirmation: null
    });
    await this.dependencies.store.updateConfirmation(
      latest.id,
      latest.revision,
      cleared
    );
  }

  private async readStoredEvidence(
    input: StoredConfirmationApproveInput
  ): Promise<GenerationConfirmationEvidence> {
    try {
      const parsed = JSON.parse((
        await this.dependencies.store.readEvidence(
          input.generationId,
          confirmationEvidencePath(input.challengeId)
        )
      ).toString("utf8")) as unknown;
      const evidence = GenerationConfirmationEvidenceSchema.parse(parsed);
      if (
        evidence.proposal.binding.generationId !== input.generationId
        || evidence.snapshot.generationId !== input.generationId
      ) {
        throw new Error(
          "Generation confirmation evidence belongs to another session"
        );
      }
      return evidence;
    } catch (error) {
      throw bindingFailure(
        error instanceof Error
          ? `Generation confirmation evidence is unavailable: ${error.message}`
          : "Generation confirmation evidence is unavailable"
      );
    }
  }
}
