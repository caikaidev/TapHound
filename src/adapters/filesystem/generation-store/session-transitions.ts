// Parsing and the allowed state transitions of a stored generation session.

import {
  GenerationInFlightSchema,
  GenerationSessionSchema,
  VerificationPhaseSchema,
  generationCoreIdentity,
  type GenerationInFlight,
  type GenerationSession,
  type VerificationPhase
} from "../../../domain/generation.js";
import {
  GenerationSessionStoreError
} from "../../../ports/generation-session-store.js";


export function assertId(id: unknown): asserts id is string {
  if (
    typeof id !== "string"
    || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_ID",
      "Invalid generation session id"
    );
  }
}

export function parseSession(
  value: unknown,
  classifyInvalidId = false
): GenerationSession {
  try {
    return GenerationSessionSchema.parse(value);
  } catch (error) {
    if (classifyInvalidId && value !== null && typeof value === "object") {
      try {
        const id = Reflect.get(value, "id") as unknown;
        if (typeof id === "string") {
          assertId(id);
        }
      } catch (idError) {
        if (idError instanceof GenerationSessionStoreError) {
          throw idError;
        }
      }
    }
    throw new GenerationSessionStoreError(
      "INVALID_SESSION",
      "Generation session state is invalid",
      { cause: error }
    );
  }
}

export function sessionId(value: GenerationSession): string {
  const id: unknown = value.id;
  assertId(id);
  return id;
}

export function parseVerificationPhase(value: unknown): VerificationPhase {
  try {
    return VerificationPhaseSchema.parse(value);
  } catch (error) {
    throw new GenerationSessionStoreError(
      "INVALID_SESSION",
      "Verification phase is invalid",
      { cause: error }
    );
  }
}

export function validateExpectedRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new GenerationSessionStoreError(
      "INVALID_REVISION",
      "Invalid expected generation revision"
    );
  }
}

export function validateInitialRevision(session: GenerationSession): void {
  if (session.revision !== 0) {
    throw new GenerationSessionStoreError(
      "INVALID_REVISION",
      "A new generation session must start at revision 0"
    );
  }
}

export function validateNextRevision(
  id: string,
  expectedRevision: number,
  next: GenerationSession
): void {
  validateExpectedRevision(expectedRevision);
  if (expectedRevision === Number.MAX_SAFE_INTEGER) {
    throw new GenerationSessionStoreError(
      "INVALID_REVISION",
      "Generation revision cannot increment beyond Number.MAX_SAFE_INTEGER"
    );
  }
  if (sessionId(next) !== id) {
    throw new GenerationSessionStoreError(
      "INVALID_ID",
      "Updated generation session id does not match the requested id"
    );
  }
  if (next.revision !== expectedRevision + 1) {
    throw new GenerationSessionStoreError(
      "INVALID_REVISION",
      "Next generation revision must increment expectedRevision by exactly one"
    );
  }
}

export function parseInFlight(value: unknown): GenerationInFlight {
  try {
    return GenerationInFlightSchema.parse(value);
  } catch (error) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Expected inFlight record is invalid",
      { cause: error }
    );
  }
}

export function sameInFlight(
  left: GenerationSession["inFlight"],
  right: GenerationSession["inFlight"]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function transitionStableState(
  session: GenerationSession
): Record<string, unknown> {
  return {
    version: session.version,
    id: session.id,
    bindings: session.bindings,
    target: session.target,
    variables: session.variables,
    ...(session.baseFlow === undefined ? {} : { baseFlow: session.baseFlow }),
    candidateSteps: session.candidateSteps,
    candidateSources: session.candidateSources,
    pendingConfirmation: session.pendingConfirmation,
    verification: session.verification,
    verificationHistory: session.verificationHistory,
    publication: session.publication
  };
}

export function assertCoreIdentityPreserved(
  current: GenerationSession,
  next: GenerationSession
): void {
  const currentIdentity = generationCoreIdentity(current);
  const nextIdentity = generationCoreIdentity(next);
  if (
    JSON.stringify(currentIdentity) !== JSON.stringify(nextIdentity)
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Generation Core identity is immutable"
    );
  }
}

export function assertLatestSnapshotPreserved(
  current: GenerationSession,
  next: GenerationSession
): void {
  if (current.bindings.snapshotHash !== next.bindings.snapshotHash) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Latest snapshot may only change through commitSnapshot"
    );
  }
}

export function assertSnapshotTransition(
  current: GenerationSession,
  next: GenerationSession
): void {
  assertCoreIdentityPreserved(current, next);
  const currentBindings = {
    projectHash: current.bindings.projectHash,
    configHash: current.bindings.configHash,
    contextHash: current.bindings.contextHash,
    uiBackend: current.bindings.uiBackend
  };
  const { snapshotHash: nextSnapshotHash, ...nextBindings } = next.bindings;
  if (
    current.state !== "active"
    || current.inFlight !== null
    || current.pendingConfirmation !== null
    || current.verification.status !== "notRun"
    || current.publication.status !== "notRun"
    || next.state !== "active"
    || next.inFlight !== null
    || next.pendingConfirmation !== null
    || nextSnapshotHash === null
    || JSON.stringify(currentBindings) !== JSON.stringify(nextBindings)
    || JSON.stringify({
      ...transitionStableState(current),
      bindings: undefined
    }) !== JSON.stringify({
      ...transitionStableState(next),
      bindings: undefined
    })
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Snapshot commit may only replace the active snapshot binding"
    );
  }
}

export function assertOrdinaryTransition(
  current: GenerationSession,
  next: GenerationSession
): void {
  assertCoreIdentityPreserved(current, next);
  assertLatestSnapshotPreserved(current, next);
  if (
    current.verification.status !== "notRun"
    || current.publication.status !== "notRun"
    || JSON.stringify(current.verification) !== JSON.stringify(next.verification)
    || JSON.stringify(current.publication) !== JSON.stringify(next.publication)
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Verification and publication require explicit transitions"
    );
  }
  if (current.state === "recoveryRequired") {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Recovery-required state must use the explicit recovery transition"
    );
  }
  if (
    JSON.stringify(current.pendingConfirmation)
    !== JSON.stringify(next.pendingConfirmation)
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Pending confirmation must use the explicit confirmation transition"
    );
  }
  const stableStateMatches = JSON.stringify(transitionStableState(current))
    === JSON.stringify(transitionStableState(next));
  if (current.inFlight !== null) {
    if (
      next.state === "recoveryRequired"
      && sameInFlight(current.inFlight, next.inFlight)
      && stableStateMatches
    ) {
      return;
    }
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Persisted inFlight may only be marked recoveryRequired without mutation"
    );
  }

  if (
    next.state === "recoveryRequired"
    || (next.inFlight !== null && !stableStateMatches)
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Starting inFlight cannot mutate candidate or result state"
    );
  }
}

export function verificationStableState(
  session: GenerationSession
): Record<string, unknown> {
  return {
    ...transitionStableState(session),
    verification: undefined
  };
}

export function assertVerificationCompletionTransition(
  current: GenerationSession,
  next: GenerationSession,
  status: "passed" | "failed"
): void {
  assertCoreIdentityPreserved(current, next);
  assertLatestSnapshotPreserved(current, next);
  if (
    current.state !== "active"
    || next.state !== "active"
    || current.inFlight !== null
    || next.inFlight !== null
    || current.pendingConfirmation !== null
    || next.pendingConfirmation !== null
    || current.verification.status !== "running"
    || next.verification.status !== status
    || next.publication.status !== "notRun"
    || JSON.stringify(verificationStableState(current))
      !== JSON.stringify(verificationStableState(next))
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      `Verification completion must record ${status} from the running attempt`
    );
  }
  if (
    next.verification.status === "passed"
    && next.verification.attemptId !== current.verification.attemptId
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Verification completion attempt does not match"
    );
  }
}

export function assertVerificationRecoveryTransition(
  current: GenerationSession,
  next: GenerationSession
): void {
  assertCoreIdentityPreserved(current, next);
  assertLatestSnapshotPreserved(current, next);
  if (
    current.state !== "active"
    || next.state !== "active"
    || current.inFlight !== null
    || next.inFlight !== null
    || current.pendingConfirmation !== null
    || next.pendingConfirmation !== null
    || current.verification.status !== "running"
    || next.verification.status !== "notRun"
    || current.publication.status !== "notRun"
    || next.publication.status !== "notRun"
    || JSON.stringify(verificationStableState(current))
      !== JSON.stringify(verificationStableState(next))
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Verification recovery may only reset an interrupted running attempt"
    );
  }
}

export function assertVerificationReopenTransition(
  current: GenerationSession,
  next: GenerationSession
): void {
  assertCoreIdentityPreserved(current, next);
  assertLatestSnapshotPreserved(current, next);
  const currentHistory = current.verificationHistory;
  const nextHistory = next.verificationHistory;
  const expectedHistory = current.verification.status === "failed"
    ? [
        ...currentHistory,
        {
          failedRevision: current.revision,
          reopenedAt: nextHistory.at(-1)?.reopenedAt,
          reason: nextHistory.at(-1)?.reason,
          failure: current.verification.failure
        }
      ]
    : currentHistory;
  const stable = (session: GenerationSession): Record<string, unknown> => ({
    ...transitionStableState(session),
    verification: undefined,
    verificationHistory: undefined
  });
  if (
    current.state !== "active"
    || next.state !== "active"
    || current.inFlight !== null
    || next.inFlight !== null
    || current.pendingConfirmation !== null
    || next.pendingConfirmation !== null
    || current.verification.status !== "failed"
    || next.verification.status !== "notRun"
    || current.publication.status !== "notRun"
    || next.publication.status !== "notRun"
    || nextHistory.length !== currentHistory.length + 1
    || nextHistory.at(-1)?.reason.trim().length === 0
    || JSON.stringify(nextHistory) !== JSON.stringify(expectedHistory)
    || JSON.stringify(stable(current)) !== JSON.stringify(stable(next))
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Verification reopen may only preserve one failed attempt in history and reset it to notRun"
    );
  }
}

export function assertBundlePublishableTransition(
  current: GenerationSession,
  next: GenerationSession
): void {
  assertCoreIdentityPreserved(current, next);
  assertLatestSnapshotPreserved(current, next);
  if (
    current.state !== "active"
    || next.state !== "active"
    || current.inFlight !== null
    || next.inFlight !== null
    || current.pendingConfirmation !== null
    || next.pendingConfirmation !== null
    || current.verification.status !== "passed"
    || JSON.stringify(current.verification) !== JSON.stringify(next.verification)
    || current.publication.status !== "notRun"
    || next.publication.status !== "published"
    || JSON.stringify({
      ...transitionStableState(current),
      publication: undefined
    }) !== JSON.stringify({
      ...transitionStableState(next),
      publication: undefined
    })
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Bundle publication must be explicitly marked after passed verification"
    );
  }
}

export function confirmationStableState(
  session: GenerationSession
): Record<string, unknown> {
  const stable = transitionStableState(session);
  return { ...stable, pendingConfirmation: undefined };
}

export function assertConfirmationTransition(
  current: GenerationSession,
  next: GenerationSession
): void {
  assertCoreIdentityPreserved(current, next);
  assertLatestSnapshotPreserved(current, next);
  if (
    current.state !== "active"
    || next.state !== "active"
    || current.inFlight !== null
    || next.inFlight !== null
    || current.verification.status !== "notRun"
    || current.publication.status !== "notRun"
    || JSON.stringify(confirmationStableState(current))
      !== JSON.stringify(confirmationStableState(next))
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Confirmation transition may only change pending confirmation state"
    );
  }

  const before = current.pendingConfirmation;
  const after = next.pendingConfirmation;
  if (before === null) {
    if (after !== null && after.status === "pending") {
      return;
    }
  } else if (after === null) {
    return;
  } else if (
    before.status === "pending"
    && after.status === "approved"
    && before.approvalMode === undefined
    && after.approvalMode !== undefined
    && JSON.stringify({
      ...before,
      status: undefined,
      approvalMode: undefined
    }) === JSON.stringify({
      ...after,
      status: undefined,
      approvalMode: undefined
    })
  ) {
    return;
  }
  throw new GenerationSessionStoreError(
    "INVALID_TRANSITION",
    "Invalid pending confirmation lifecycle transition"
  );
}

export function assertRecoveryTransition(
  current: GenerationSession,
  next: GenerationSession
): void {
  assertCoreIdentityPreserved(current, next);
  assertLatestSnapshotPreserved(current, next);
  if (
    current.state !== "recoveryRequired"
    || current.inFlight === null
    || next.state !== "active"
    || next.inFlight !== null
    || JSON.stringify(transitionStableState(current))
      !== JSON.stringify(transitionStableState(next))
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Recovery must only clear preserved inFlight evidence and reactivate state"
    );
  }
}

export function assertArchiveTransition(
  current: GenerationSession,
  next: GenerationSession
): void {
  assertCoreIdentityPreserved(current, next);
  assertLatestSnapshotPreserved(current, next);
  if (
    current.state !== "active"
    || current.inFlight !== null
    || current.pendingConfirmation !== null
    || next.state !== "archived"
    || next.inFlight !== null
    || next.pendingConfirmation !== null
    || JSON.stringify(transitionStableState(current))
      !== JSON.stringify(transitionStableState(next))
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Archive may only mark an idle active session as archived without mutation"
    );
  }
}
