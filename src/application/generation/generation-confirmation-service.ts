import {
  GenerationSessionSchema,
  type GenerationSession,
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
    "read" | "updateConfirmation"
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
}

export interface ConfirmationApproveInput extends ConfirmationRequestInput {
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
      snapshot: input.snapshot
    });
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
      await this.clear(session);
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
      await this.clear(session);
      throw bindingFailure(
        "Generation proposal or runtime state changed before confirmation"
      );
    }

    let confirmed: boolean;
    try {
      confirmed = await this.dependencies.prompt.confirm(challenge);
    } catch (error) {
      await this.clearChallenge(session.id, challenge.challengeId);
      throw error;
    }
    if (!confirmed) {
      await this.clearChallenge(session.id, challenge.challengeId);
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
      if (
        latest.pendingConfirmation?.challengeId === challenge.challengeId
      ) {
        await this.clear(latest);
      }
      throw bindingFailure(
        "Generation confirmation state changed while prompting"
      );
    }
    if (latest.revision === Number.MAX_SAFE_INTEGER) {
      await this.clear(latest);
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

  private async clear(session: GenerationSession): Promise<void> {
    if (session.pendingConfirmation === null) {
      return;
    }
    if (session.revision === Number.MAX_SAFE_INTEGER) {
      throw bindingFailure("Generation revision cannot clear challenge");
    }
    const cleared = GenerationSessionSchema.parse({
      ...session,
      revision: session.revision + 1,
      pendingConfirmation: null
    });
    await this.dependencies.store.updateConfirmation(
      session.id,
      session.revision,
      cleared
    );
  }

  private async clearChallenge(
    generationId: string,
    challengeId: string
  ): Promise<void> {
    const latest = GenerationSessionSchema.parse(
      await this.dependencies.store.read(generationId)
    );
    if (latest.pendingConfirmation?.challengeId !== challengeId) {
      return;
    }
    await this.clear(latest);
  }
}
