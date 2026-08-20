import {
  GenerationConfirmationEvidenceSchema,
  GenerationSessionIdSchema,
  GenerationSessionSchema,
  hashGenerationConfirmationEvidence,
  type GenerationConfirmationEvidence,
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
import {
  GenerationPromptCancelledError,
  type GenerationPromptPort,
  type ManualProposalInput
} from "../../ports/generation-prompt.js";
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
  signal?: AbortSignal | undefined;
}

export interface StoredConfirmationApproveInput {
  generationId: string;
  challengeId: string;
  signal?: AbortSignal | undefined;
}

export interface ManualConfirmationRequestInput {
  generationId: string;
  snapshot: RuntimeSnapshot;
  manual: ManualProposalInput;
  signal?: AbortSignal | undefined;
}

export interface PendingManualConfirmationInput {
  generationId: string;
  action: ManualProposalInput["action"];
}

export interface ConfirmationRequiredResult {
  status: "confirmationRequired";
  challenge: PendingConfirmation;
}

export type ConfirmationRequestResult =
  | { status: "approved"; proposal: ProposedStep }
  | ConfirmationRequiredResult;

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
    const submittedEvidence = GenerationConfirmationEvidenceSchema.parse({
      version: 1,
      proposal: input.proposal,
      snapshot: input.snapshot,
      source: input.source ?? "planner"
    });
    if (
      session.pendingConfirmation !== null
      && session.pendingConfirmation.status === "pending"
    ) {
      const storedEvidence = await this.readStoredEvidence({
        generationId: session.id,
        challengeId: session.pendingConfirmation.challengeId
      });
      if (JSON.stringify(storedEvidence) !== JSON.stringify(submittedEvidence)) {
        throw bindingFailure(
          "Pending generation confirmation does not match submitted evidence"
        );
      }
      const challenge = this.requireExactPendingChallenge(
        session,
        storedEvidence
      );
      return { status: "confirmationRequired", challenge };
    }
    const proposal = this.validator.validate({
      session,
      snapshot: submittedEvidence.snapshot,
      proposal: submittedEvidence.proposal
    });
    const risk = this.riskEvaluator.evaluate(
      proposal,
      session.target.interactionPolicy,
      submittedEvidence.snapshot
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

    const evidence = GenerationConfirmationEvidenceSchema.parse({
      version: 1,
      proposal,
      snapshot: submittedEvidence.snapshot,
      source: submittedEvidence.source
    });
    const challenge = {
      challengeId: this.dependencies.generateChallengeId(),
      stepIndex: session.candidateSteps.length,
      proposalHash: hashProposedStep(proposal),
      snapshotHash: proposal.binding.snapshotHash,
      evidenceHash: hashGenerationConfirmationEvidence(evidence),
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
    await this.dependencies.store.writeEvidence(
      session.id,
      confirmationEvidencePath(challenge.challengeId),
      evidence
    );
    await this.updateConfirmationReconciled(
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
      input.manual,
      input.signal
    );
    if (input.signal?.aborted === true) {
      throw new GenerationPromptCancelledError();
    }
    return this.request({
      generationId: input.generationId,
      proposal,
      snapshot: input.snapshot,
      source: "manualOverride"
    });
  };

  public readonly findPendingManual = async (
    input: PendingManualConfirmationInput
  ): Promise<ConfirmationRequiredResult | null> => {
    const session = GenerationSessionSchema.parse(
      await this.dependencies.store.read(input.generationId)
    );
    const pending = session.pendingConfirmation;
    if (pending === null || pending.status !== "pending") {
      return null;
    }
    const evidence = await this.readStoredEvidence({
      generationId: session.id,
      challengeId: pending.challengeId
    });
    if (
      evidence.source !== "manualOverride"
      || evidence.proposal.action !== input.action
    ) {
      throw bindingFailure(
        "Pending manual confirmation does not match the requested action"
      );
    }
    const challenge = this.requireExactPendingChallenge(session, evidence);
    return { status: "confirmationRequired", challenge };
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
      source: evidence.source,
      signal: input.signal
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
    const evidence = GenerationConfirmationEvidenceSchema.parse({
      version: 1,
      proposal,
      snapshot,
      source: input.source ?? "planner"
    });
    const evidenceHash = hashGenerationConfirmationEvidence(evidence);
    const challenge = session.pendingConfirmation;
    if (challenge === null) {
      throw bindingFailure("No pending generation confirmation exists");
    }
    const expectedRevision = proposal.binding.baseRevision
      + (challenge.status === "pending" ? 1 : 2);
    const cleanupToken: PendingChallengeToken = {
      expectedRevision,
      expectedChallenge: challenge
    };

    const expired = this.dependencies.now().getTime()
      >= new Date(challenge.expiresAt).getTime();
    const challengeMatches = challenge.challengeId === input.challengeId;
    const proposalMatches = challenge.proposalHash
      === hashProposedStep(proposal);
    const evidenceMatches = challenge.evidenceHash === evidenceHash;
    const snapshotMatches = challenge.snapshotHash
      === hashRuntimeSnapshot(snapshot)
      && challenge.snapshotHash === proposal.binding.snapshotHash
      && challenge.snapshotHash === session.bindings.snapshotHash;
    const stateMatches = session.state === "active"
      && session.inFlight === null
      && session.verification.status === "notRun"
      && session.publication.status === "notRun"
      && session.revision === expectedRevision
      && challenge.stepIndex === session.candidateSteps.length
      && challenge.actionSummary === summarizeProposedStep(proposal);

    if (
      expired
      || !challengeMatches
      || !proposalMatches
      || !evidenceMatches
      || !snapshotMatches
      || !stateMatches
    ) {
      if (challengeMatches) {
        await this.clearExactChallenge(session.id, cleanupToken);
      }
      if (expired) {
        throw bindingFailure("Generation confirmation challenge expired");
      }
      if (!evidenceMatches) {
        throw bindingFailure(
          "Generation confirmation evidence hash is not authoritative"
        );
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
      await this.clearExactChallenge(session.id, cleanupToken);
      throw bindingFailure(
        "Generation proposal or runtime state changed before confirmation"
      );
    }

    if (challenge.status === "approved") {
      return { status: "approved", proposal };
    }

    let confirmed: boolean;
    try {
      confirmed = await this.dependencies.prompt.confirm(
        challenge,
        input.signal
      );
    } catch (error) {
      await this.clearExactChallenge(session.id, cleanupToken);
      throw error;
    }
    if (input.signal?.aborted === true) {
      await this.cancelPrompt(session.id, cleanupToken);
    }
    if (!confirmed) {
      await this.clearExactChallenge(session.id, cleanupToken);
      throw bindingFailure("Generation action confirmation was declined");
    }

    const latest = GenerationSessionSchema.parse(
      await this.dependencies.store.read(input.generationId)
    );
    if (input.signal?.aborted === true) {
      await this.cancelPrompt(session.id, cleanupToken);
    }
    const stillAuthoritative = latest.revision === session.revision
      && JSON.stringify(latest.pendingConfirmation)
        === JSON.stringify(challenge)
      && this.dependencies.now().getTime()
        < new Date(challenge.expiresAt).getTime();
    if (!stillAuthoritative) {
      await this.clearExactChallenge(session.id, cleanupToken);
      throw bindingFailure(
        "Generation confirmation state changed while prompting"
      );
    }
    if (latest.revision === Number.MAX_SAFE_INTEGER) {
      await this.clearExactChallenge(session.id, cleanupToken);
      throw bindingFailure("Generation revision cannot approve challenge");
    }
    if (input.signal?.aborted === true) {
      await this.cancelPrompt(session.id, cleanupToken);
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

  public readonly clearApproved = async (input: {
    generationId: string;
    challenge: PendingConfirmation;
  }): Promise<void> => {
    const session = GenerationSessionSchema.parse(
      await this.dependencies.store.read(input.generationId)
    );
    const challenge = session.pendingConfirmation;
    if (
      challenge === null
      || JSON.stringify(challenge) !== JSON.stringify(input.challenge)
      || challenge.status !== "approved"
    ) {
      return;
    }
    await this.clearExactChallenge(session.id, {
      expectedRevision: session.revision,
      expectedChallenge: challenge
    });
  };

  private async clearExactChallenge(
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
    await this.updateConfirmationReconciled(
      latest.id,
      latest.revision,
      cleared
    );
  }

  private async cancelPrompt(
    generationId: string,
    token: PendingChallengeToken
  ): Promise<never> {
    await this.clearExactChallenge(generationId, token);
    throw new GenerationPromptCancelledError();
  }

  private requireExactPendingChallenge(
    session: GenerationSession,
    evidence: GenerationConfirmationEvidence
  ): PendingConfirmation {
    const challenge = session.pendingConfirmation;
    const proposal = evidence.proposal;
    const snapshot = evidence.snapshot;
    if (
      challenge === null
      || challenge.status !== "pending"
      || session.revision !== proposal.binding.baseRevision + 1
    ) {
      throw bindingFailure(
        "Pending generation confirmation is no longer authoritative"
      );
    }
    try {
      const baseSession = GenerationSessionSchema.parse({
        ...session,
        revision: proposal.binding.baseRevision,
        pendingConfirmation: null
      });
      this.validator.validate({
        session: baseSession,
        snapshot,
        proposal
      });
    } catch {
      throw bindingFailure(
        "Pending generation confirmation is no longer authoritative"
      );
    }
    const risk = this.riskEvaluator.evaluate(
      proposal,
      session.target.interactionPolicy,
      snapshot
    );
    if (
      risk.effectiveRisk !== "confirmationRequired"
      || challenge.stepIndex !== session.candidateSteps.length
      || challenge.proposalHash !== hashProposedStep(proposal)
      || challenge.snapshotHash !== hashRuntimeSnapshot(snapshot)
      || challenge.snapshotHash !== proposal.binding.snapshotHash
      || challenge.evidenceHash !== hashGenerationConfirmationEvidence(evidence)
      || challenge.actionSummary !== summarizeProposedStep(proposal)
      || this.dependencies.now().getTime()
        >= new Date(challenge.expiresAt).getTime()
    ) {
      throw bindingFailure(
        "Pending generation confirmation does not match stored evidence"
      );
    }
    return challenge;
  }

  private async updateConfirmationReconciled(
    generationId: string,
    expectedRevision: number,
    intended: GenerationSession
  ): Promise<void> {
    try {
      await this.dependencies.store.updateConfirmation(
        generationId,
        expectedRevision,
        intended
      );
    } catch (error) {
      let authoritative: GenerationSession;
      try {
        authoritative = GenerationSessionSchema.parse(
          await this.dependencies.store.read(generationId)
        );
      } catch {
        throw error;
      }
      if (JSON.stringify(authoritative) === JSON.stringify(intended)) {
        return;
      }
      throw error;
    }
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
