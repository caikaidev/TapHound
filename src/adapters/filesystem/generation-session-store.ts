import { randomUUID } from "node:crypto";
import type {
  BigIntStats
} from "node:fs";
import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import {
  dirname,
  join,
  resolve
} from "node:path";

import {
  GenerationSessionSchema,
  PendingConfirmationSchema,
  isGenerationConfirmationExpired,
  type GenerationInFlight,
  type GenerationSession,
  type PendingConfirmation,
  type VerificationPhase
} from "../../domain/generation.js";
import {
  BUILD_DIR,
  GENERATIONS_DIR,
  TAPHOUND_DIR,
  activeGenerationBundleName
} from "../../domain/workspace.js";
import {
  GenerationSessionStoreError,
  type GenerationSessionStore
} from "../../ports/generation-session-store.js";
import { isErrnoException } from "../../shared/errors.js";
import { compareStrings } from "../../shared/strings.js";
import { ensureBuildIgnored } from "./workspace-layout.js";
import {
  SessionLock
} from "./generation-store/session-lock.js";
import {
  assertArchiveTransition,
  assertBundlePublishableTransition,
  assertConfirmationTransition,
  assertCoreIdentityPreserved,
  assertId,
  assertLatestSnapshotPreserved,
  assertOrdinaryTransition,
  assertRecoveryTransition,
  assertSnapshotTransition,
  assertVerificationCompletionTransition,
  assertVerificationRecoveryTransition,
  assertVerificationReopenTransition,
  parseInFlight,
  parseSession,
  parseVerificationPhase,
  sameInFlight,
  sessionId,
  transitionStableState,
  validateExpectedRevision,
  validateInitialRevision,
  validateNextRevision
} from "./generation-store/session-transitions.js";
import {
  type DirectoryEvidence,
  type FileIdentity,
  asStoreIoError,
  assertContained,
  assertEvidenceNamespaceAvailable,
  canonicalizeEvidence,
  captureDirectoryEvidence,
  captureStoreDirectory,
  createOrRequireDirectory,
  evidenceEntrySnapshot,
  evidenceNotFound,
  fileIdentity,
  pathExists,
  readBoundState,
  readStateFromDirectory,
  requireRealDirectory,
  sameIdentity,
  sameSnapshotMetadata,
  serializeJson,
  snapshotMetadata,
  syncDirectory,
  validateEvidencePath,
  verifyDirectoryEvidence,
  verifyStoreDirectory,
  writeStateAtomically
} from "./generation-store/store-files.js";

export interface FileSystemGenerationSessionStoreOptions {
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  now?: (() => Date) | undefined;
  hooks?: FileSystemGenerationSessionStoreHooks;
  generationRoot?: string | undefined;
}

export interface FileSystemGenerationSessionStoreHooks {
  beforeLockStagingWrite?: () => Promise<void> | void;
  beforeLockInstall?: () => Promise<void> | void;
  afterLockTombstoneRename?: () => Promise<void> | void;
  afterStateOpen?: () => Promise<void> | void;
  beforeStateRename?: () => Promise<void> | void;
  beforePublishRename?: () => Promise<void> | void;
  beforeEvidenceInstall?: () => Promise<void> | void;
  afterEvidenceInstall?: () => Promise<void> | void;
  afterEvidenceOpen?: (path: string) => Promise<void> | void;
  afterEvidenceRead?: (path: string) => Promise<void> | void;
  afterEvidenceDirectoryRead?: (
    path: string,
    phase: "beforeTraversal" | "afterTraversal"
  ) => Promise<void> | void;
  afterDirectorySync?: (path: string) => Promise<void> | void;
}

interface RequiredStoreOptions {
  lockTimeoutMs: number;
  lockRetryMs: number;
  generationRoot?: string | undefined;
}

const DEFAULT_OPTIONS: RequiredStoreOptions = {
  lockTimeoutMs: 2_000,
  lockRetryMs: 10
};

function activeBundleName(id: string): string {
  return activeGenerationBundleName(id);
}

const HOOK_NAMES = [
  "beforeLockStagingWrite",
  "beforeLockInstall",
  "afterLockTombstoneRename",
  "afterStateOpen",
  "beforeStateRename",
  "beforePublishRename",
  "beforeEvidenceInstall",
  "afterEvidenceInstall",
  "afterEvidenceOpen",
  "afterEvidenceRead",
  "afterEvidenceDirectoryRead",
  "afterDirectorySync"
] as const satisfies readonly (keyof FileSystemGenerationSessionStoreHooks)[];

function parseStoreConfiguration(
  projectRoot: unknown,
  options: unknown
): {
  projectRoot: string;
  options: RequiredStoreOptions;
  now: () => Date;
  hooks: FileSystemGenerationSessionStoreHooks;
} {
  try {
    if (typeof projectRoot !== "string") {
      throw new TypeError("projectRoot must be a string");
    }
    if (options === null || typeof options !== "object") {
      throw new TypeError("options must be an object");
    }
    const lockTimeoutInput = Reflect.get(options, "lockTimeoutMs") as unknown;
    const lockRetryInput = Reflect.get(options, "lockRetryMs") as unknown;
    const nowInput = Reflect.get(options, "now") as unknown;
    const lockTimeoutMs = lockTimeoutInput
      ?? DEFAULT_OPTIONS.lockTimeoutMs;
    const lockRetryMs = lockRetryInput ?? DEFAULT_OPTIONS.lockRetryMs;
    if (
      !Number.isSafeInteger(lockTimeoutMs)
      || (lockTimeoutMs as number) < 0
      || !Number.isSafeInteger(lockRetryMs)
      || (lockRetryMs as number) < 0
    ) {
      throw new TypeError("lock timing options must be safe integers");
    }
    if (nowInput !== undefined && typeof nowInput !== "function") {
      throw new TypeError("now must be a function");
    }

    const generationRootInput = Reflect.get(options, "generationRoot") as unknown;
    if (
      generationRootInput !== undefined
      && typeof generationRootInput !== "string"
    ) {
      throw new TypeError("generationRoot must be a string");
    }

    const hooksInput = Reflect.get(options, "hooks") as unknown;
    const hooks: FileSystemGenerationSessionStoreHooks = {};
    if (hooksInput !== undefined) {
      if (hooksInput === null || typeof hooksInput !== "object") {
        throw new TypeError("hooks must be an object");
      }
      for (const name of HOOK_NAMES) {
        const hook = Reflect.get(hooksInput, name) as unknown;
        if (hook !== undefined && typeof hook !== "function") {
          throw new TypeError(`${name} must be a function`);
        }
        if (hook !== undefined) {
          hooks[name] = hook as never;
        }
      }
    }
    return {
      projectRoot: resolve(projectRoot),
      options: {
        lockTimeoutMs: lockTimeoutMs as number,
        lockRetryMs: lockRetryMs as number,
        ...(generationRootInput === undefined
          ? {}
          : { generationRoot: generationRootInput })
      },
      now: (nowInput ?? ((): Date => new Date())) as () => Date,
      hooks
    };
  } catch (error) {
    throw new GenerationSessionStoreError(
      "IO_ERROR",
      "Generation session store configuration is invalid",
      { cause: error }
    );
  }
}

export class FileSystemGenerationSessionStore
implements GenerationSessionStore {
  private readonly projectRoot: string;
  private readonly generationRoot: string;
  private readonly locksRoot: string;
  private readonly options: RequiredStoreOptions;
  private readonly now: () => Date;
  private readonly hooks: FileSystemGenerationSessionStoreHooks;
  private readonly customGenerationRoot: boolean;
  private readonly lock: SessionLock;

  public constructor(
    projectRoot: string,
    options: FileSystemGenerationSessionStoreOptions = {}
  ) {
    const configuration = parseStoreConfiguration(projectRoot, options);
    this.projectRoot = configuration.projectRoot;
    this.generationRoot = typeof configuration.options.generationRoot === "string"
      ? resolve(configuration.options.generationRoot)
      : join(this.projectRoot, GENERATIONS_DIR);
    this.customGenerationRoot = this.generationRoot !== join(this.projectRoot, GENERATIONS_DIR);
    this.locksRoot = join(this.generationRoot, ".locks");
    this.options = configuration.options;
    this.now = configuration.now;
    this.hooks = configuration.hooks;
    this.lock = new SessionLock({
      generationRoot: this.generationRoot,
      locksRoot: this.locksRoot,
      lockTimeoutMs: this.options.lockTimeoutMs,
      lockRetryMs: this.options.lockRetryMs,
      hooks: this.hooks
    });
  }

  public readonly create = async (
    input: GenerationSession
  ): Promise<void> => {
    const session = parseSession(input, true);
    const id = sessionId(session);
    validateInitialRevision(session);
    await this.ensureGenerationRoot();

    await this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      const finalDirectory = this.finalDirectory(id);
      if (
        await pathExists(activeDirectory)
        || await pathExists(finalDirectory)
      ) {
        throw new GenerationSessionStoreError(
          "SESSION_ALREADY_EXISTS",
          `Generation session already exists: ${id}`
        );
      }

      await mkdir(activeDirectory);
      try {
        const activeEvidence = await captureStoreDirectory(activeDirectory);
        await writeStateAtomically(
          activeDirectory,
          session,
          this.syncDirectory,
          this.hooks.beforeStateRename,
          activeEvidence
        );
        await this.syncDirectory(this.generationRoot);
      } catch (error) {
        await rm(activeDirectory).catch(() => undefined);
        throw error;
      }
    });
  };

  public readonly read = async (id: string): Promise<GenerationSession> => {
    assertId(id);
    await this.ensureGenerationRoot();
    return this.withLock(id, async () => {
      const finalDirectory = this.finalDirectory(id);
      if (await pathExists(finalDirectory)) {
        const finalEvidence = await captureStoreDirectory(finalDirectory);
        return readBoundState(
          finalDirectory,
          id,
          this.hooks.afterStateOpen,
          finalEvidence
        );
      }
      const activeDirectory = this.activeDirectory(id);
      if (await pathExists(activeDirectory)) {
        const activeEvidence = await captureStoreDirectory(activeDirectory);
        return readBoundState(
          activeDirectory,
          id,
          this.hooks.afterStateOpen,
          activeEvidence
        );
      }
      throw new GenerationSessionStoreError(
        "SESSION_NOT_FOUND",
        `Generation session does not exist: ${id}`
      );
    });
  };

  public readonly update = async (
    id: string,
    expectedRevision: number,
    input: GenerationSession
  ): Promise<void> => {
    assertId(id);
    const next = parseSession(input, true);
    validateNextRevision(id, expectedRevision, next);
    await this.ensureGenerationRoot();

    await this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      if (!await pathExists(activeDirectory)) {
        if (await pathExists(this.finalDirectory(id))) {
          throw new GenerationSessionStoreError(
            "SESSION_PUBLISHED",
            `Published generation session cannot be updated: ${id}`
          );
        }
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }

      const activeEvidence = await captureStoreDirectory(activeDirectory);
      const current = await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );
      if (current.revision !== expectedRevision) {
        throw new GenerationSessionStoreError(
          "REVISION_CONFLICT",
          `Expected generation revision ${String(expectedRevision)}, found ${
            String(current.revision)
          }`
        );
      }
      assertOrdinaryTransition(current, next);
      await writeStateAtomically(
        activeDirectory,
        next,
        this.syncDirectory,
        this.hooks.beforeStateRename,
        activeEvidence
      );
    });
  };

  public readonly commitSnapshot = async (
    id: string,
    expectedRevision: number,
    input: GenerationSession
  ): Promise<void> => {
    assertId(id);
    const next = parseSession(input, true);
    validateNextRevision(id, expectedRevision, next);
    await this.ensureGenerationRoot();

    await this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      if (!await pathExists(activeDirectory)) {
        if (await pathExists(this.finalDirectory(id))) {
          throw new GenerationSessionStoreError(
            "SESSION_PUBLISHED",
            `Published generation session cannot commit a snapshot: ${id}`
          );
        }
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }

      const activeEvidence = await captureStoreDirectory(activeDirectory);
      const current = await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );
      if (current.revision !== expectedRevision) {
        throw new GenerationSessionStoreError(
          "REVISION_CONFLICT",
          `Expected generation revision ${String(expectedRevision)}, found ${
            String(current.revision)
          }`
        );
      }
      assertSnapshotTransition(current, next);
      await writeStateAtomically(
        activeDirectory,
        next,
        this.syncDirectory,
        this.hooks.beforeStateRename,
        activeEvidence
      );
    });
  };

  public readonly updateConfirmation = async (
    id: string,
    expectedRevision: number,
    input: GenerationSession
  ): Promise<void> => {
    assertId(id);
    const next = parseSession(input, true);
    validateNextRevision(id, expectedRevision, next);
    await this.ensureGenerationRoot();

    await this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      if (!await pathExists(activeDirectory)) {
        if (await pathExists(this.finalDirectory(id))) {
          throw new GenerationSessionStoreError(
            "SESSION_PUBLISHED",
            `Published generation session cannot update confirmation: ${id}`
          );
        }
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }

      const activeEvidence = await captureStoreDirectory(activeDirectory);
      const current = await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );
      if (current.revision !== expectedRevision) {
        throw new GenerationSessionStoreError(
          "REVISION_CONFLICT",
          `Expected generation revision ${String(expectedRevision)}, found ${
            String(current.revision)
          }`
        );
      }
      assertConfirmationTransition(current, next);
      await writeStateAtomically(
        activeDirectory,
        next,
        this.syncDirectory,
        this.hooks.beforeStateRename,
        activeEvidence
      );
    });
  };

  public readonly beginStep = async (
    id: string,
    expectedRevision: number,
    inFlightInput: GenerationInFlight,
    approvedConfirmationInput?: PendingConfirmation
  ): Promise<GenerationSession> => {
    assertId(id);
    validateExpectedRevision(expectedRevision);
    if (expectedRevision >= Number.MAX_SAFE_INTEGER - 1) {
      throw new GenerationSessionStoreError(
        "INVALID_REVISION",
        "Step begin must reserve a revision for completion or recovery"
      );
    }
    const inFlight = parseInFlight(inFlightInput);
    const approvedConfirmation = approvedConfirmationInput === undefined
      ? undefined
      : PendingConfirmationSchema.parse(approvedConfirmationInput);
    await this.ensureGenerationRoot();

    return this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      if (!await pathExists(activeDirectory)) {
        if (await pathExists(this.finalDirectory(id))) {
          throw new GenerationSessionStoreError(
            "SESSION_PUBLISHED",
            `Published generation session cannot begin a step: ${id}`
          );
        }
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }
      const activeEvidence = await captureStoreDirectory(activeDirectory);
      const current = await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );
      if (current.revision !== expectedRevision) {
        throw new GenerationSessionStoreError(
          "REVISION_CONFLICT",
          `Expected generation revision ${String(expectedRevision)}, found ${
            String(current.revision)
          }`
        );
      }
      const expectedConfirmation = approvedConfirmation ?? null;
      if (
        current.state !== "active"
        || current.inFlight !== null
        || current.verification.status !== "notRun"
        || current.publication.status !== "notRun"
        || inFlight.stepIndex !== current.candidateSteps.length
        || JSON.stringify(current.pendingConfirmation)
          !== JSON.stringify(expectedConfirmation)
        || (
          approvedConfirmation !== undefined
          && (
            approvedConfirmation.status !== "approved"
            || approvedConfirmation.proposalHash !== inFlight.proposalHash
            || approvedConfirmation.snapshotHash !== inFlight.snapshotHash
          )
        )
        || JSON.stringify(inFlight.confirmation) !== JSON.stringify(
          approvedConfirmation === undefined
            ? undefined
            : {
                challengeId: approvedConfirmation.challengeId,
                approvalMode: approvedConfirmation.approvalMode ?? "localTty"
              }
        )
      ) {
        throw new GenerationSessionStoreError(
          "INVALID_TRANSITION",
          "Step begin requires exact active state and approved confirmation"
        );
      }
      const next = GenerationSessionSchema.parse({
        ...current,
        revision: current.revision + 1,
        inFlight,
        pendingConfirmation: null
      });
      await writeStateAtomically(
        activeDirectory,
        next,
        this.syncDirectory,
        this.hooks.beforeStateRename,
        activeEvidence,
        async () => {
          await assertEvidenceNamespaceAvailable(
            activeDirectory,
            activeEvidence,
            inFlight
          );
          if (approvedConfirmation !== undefined) {
            const now = this.now();
            if (
              !(now instanceof Date)
              || !Number.isFinite(now.getTime())
              || isGenerationConfirmationExpired(approvedConfirmation, now)
            ) {
              throw new GenerationSessionStoreError(
                "INVALID_TRANSITION",
                "Approved confirmation expired before step begin"
              );
            }
          }
        }
      );
      return next;
    });
  };

  public readonly completeStep = async (
    id: string,
    expectedRevision: number,
    expectedInFlightInput: GenerationInFlight,
    input: GenerationSession
  ): Promise<void> => {
    await this.appendStep(
      id,
      expectedRevision,
      expectedInFlightInput,
      input,
      "active",
      "complete a step"
    );
  };

  public readonly amendStep = async (
    id: string,
    expectedRevision: number,
    expectedInFlightInput: GenerationInFlight,
    input: GenerationSession
  ): Promise<void> => {
    await this.appendStep(
      id,
      expectedRevision,
      expectedInFlightInput,
      input,
      "recoveryRequired",
      "amend a step"
    );
  };

  /**
   * Clears the matching inFlight record and appends exactly one Journey
   * step: from `active` for a completed step, from `recoveryRequired` for
   * an amended expectation.
   */
  private async appendStep(
    id: string,
    expectedRevision: number,
    expectedInFlightInput: GenerationInFlight,
    input: GenerationSession,
    fromState: "active" | "recoveryRequired",
    operation: string
  ): Promise<void> {
    assertId(id);
    const expectedInFlight = parseInFlight(expectedInFlightInput);
    const next = parseSession(input, true);
    validateNextRevision(id, expectedRevision, next);
    await this.ensureGenerationRoot();

    await this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      if (!await pathExists(activeDirectory)) {
        if (await pathExists(this.finalDirectory(id))) {
          throw new GenerationSessionStoreError(
            "SESSION_PUBLISHED",
            `Published generation session cannot ${operation}: ${id}`
          );
        }
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }

      const activeEvidence = await captureStoreDirectory(activeDirectory);
      const current = await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );
      if (current.revision !== expectedRevision) {
        throw new GenerationSessionStoreError(
          "REVISION_CONFLICT",
          `Expected generation revision ${String(expectedRevision)}, found ${
            String(current.revision)
          }`
        );
      }
      if (
        current.state !== fromState
        || current.inFlight === null
        || !sameInFlight(current.inFlight, expectedInFlight)
        || next.state !== "active"
        || next.inFlight !== null
      ) {
        throw new GenerationSessionStoreError(
          "INVALID_TRANSITION",
          "Step completion must clear the matching active inFlight record"
        );
      }
      assertCoreIdentityPreserved(current, next);
      assertLatestSnapshotPreserved(current, next);
      const candidateAppended = next.candidateSteps.length
        === current.candidateSteps.length + 1
        && JSON.stringify(next.candidateSteps.slice(
          0,
          current.candidateSteps.length
        )) === JSON.stringify(current.candidateSteps);
      const sourceAppended = next.candidateSources.length
        === current.candidateSources.length + 1
        && JSON.stringify(next.candidateSources.slice(
          0,
          current.candidateSources.length
        )) === JSON.stringify(current.candidateSources);
      const currentStable = {
        ...transitionStableState(current),
        candidateSteps: undefined,
        candidateSources: undefined,
        pendingConfirmation: undefined
      };
      const nextStable = {
        ...transitionStableState(next),
        candidateSteps: undefined,
        candidateSources: undefined,
        pendingConfirmation: undefined
      };
      if (
        !candidateAppended
        || !sourceAppended
        || current.pendingConfirmation !== null
        || next.pendingConfirmation !== null
        || JSON.stringify(currentStable) !== JSON.stringify(nextStable)
      ) {
        throw new GenerationSessionStoreError(
          "INVALID_TRANSITION",
          "Step completion must append exactly one successful Journey step"
        );
      }
      await writeStateAtomically(
        activeDirectory,
        next,
        this.syncDirectory,
        this.hooks.beforeStateRename,
        activeEvidence
      );
    });
  }

  public readonly recover = async (
    id: string,
    expectedRevision: number,
    input: GenerationSession
  ): Promise<void> => {
    assertId(id);
    const next = parseSession(input, true);
    validateNextRevision(id, expectedRevision, next);
    await this.ensureGenerationRoot();

    await this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      if (!await pathExists(activeDirectory)) {
        if (await pathExists(this.finalDirectory(id))) {
          throw new GenerationSessionStoreError(
            "SESSION_PUBLISHED",
            `Published generation session cannot be recovered: ${id}`
          );
        }
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }

      const activeEvidence = await captureStoreDirectory(activeDirectory);
      const current = await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );
      if (current.revision !== expectedRevision) {
        throw new GenerationSessionStoreError(
          "REVISION_CONFLICT",
          `Expected generation revision ${String(expectedRevision)}, found ${
            String(current.revision)
          }`
        );
      }
      assertRecoveryTransition(current, next);
      await writeStateAtomically(
        activeDirectory,
        next,
        this.syncDirectory,
        this.hooks.beforeStateRename,
        activeEvidence
      );
    });
  };

  public readonly beginVerification = async (
    id: string,
    expectedRevision: number,
    attemptId: string,
    owner?: { pid: number; startedAt: string }
  ): Promise<GenerationSession> => {
    assertId(id);
    validateExpectedRevision(expectedRevision);
    assertId(attemptId);
    if (expectedRevision > Number.MAX_SAFE_INTEGER - 3) {
      throw new GenerationSessionStoreError(
        "INVALID_REVISION",
        "Verification must reserve revisions for completion and publication"
      );
    }
    await this.ensureGenerationRoot();
    return this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      if (!await pathExists(activeDirectory)) {
        if (await pathExists(this.finalDirectory(id))) {
          throw new GenerationSessionStoreError(
            "SESSION_PUBLISHED",
            `Published generation session cannot begin verification: ${id}`
          );
        }
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }
      const activeEvidence = await captureStoreDirectory(activeDirectory);
      const current = await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );
      if (current.revision !== expectedRevision) {
        throw new GenerationSessionStoreError(
          "REVISION_CONFLICT",
          `Expected generation revision ${String(expectedRevision)}, found ${
            String(current.revision)
          }`
        );
      }
      if (
        current.state !== "active"
        || current.inFlight !== null
        || current.pendingConfirmation !== null
        || current.candidateSteps.length === 0
        || current.candidateSources.length !== current.candidateSteps.length
        || current.verification.status !== "notRun"
        || current.publication.status !== "notRun"
      ) {
        throw new GenerationSessionStoreError(
          "INVALID_TRANSITION",
          "Verification requires a complete non-empty active candidate"
        );
      }
      const next = GenerationSessionSchema.parse({
        ...current,
        revision: current.revision + 1,
        verification: {
          status: "running",
          attemptId,
          ...(owner === undefined
            ? {}
            : { ownerPid: owner.pid, startedAt: owner.startedAt })
        }
      });
      await writeStateAtomically(
        activeDirectory,
        next,
        this.syncDirectory,
        this.hooks.beforeStateRename,
        activeEvidence
      );
      return next;
    });
  };

  public readonly updateVerificationPhase = async (
    id: string,
    attemptId: string,
    phase: VerificationPhase
  ): Promise<void> => {
    assertId(id);
    assertId(attemptId);
    const parsedPhase = parseVerificationPhase(phase);
    await this.ensureGenerationRoot();
    await this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      if (!await pathExists(activeDirectory)) {
        if (await pathExists(this.finalDirectory(id))) {
          throw new GenerationSessionStoreError(
            "SESSION_PUBLISHED",
            `Published generation session cannot update verification phase: ${id}`
          );
        }
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }
      const activeEvidence = await captureStoreDirectory(activeDirectory);
      const current = await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );
      if (
        current.state !== "active"
        || current.verification.status !== "running"
        || current.verification.attemptId !== attemptId
        || current.publication.status !== "notRun"
      ) {
        throw new GenerationSessionStoreError(
          "INVALID_TRANSITION",
          "Verification phase updates require the exact active running attempt"
        );
      }
      const next = GenerationSessionSchema.parse({
        ...current,
        verification: {
          ...current.verification,
          phase: parsedPhase
        }
      });
      await writeStateAtomically(
        activeDirectory,
        next,
        this.syncDirectory,
        this.hooks.beforeStateRename,
        activeEvidence
      );
    });
  };

  public readonly abortVerification = async (
    id: string,
    expectedRevision: number
  ): Promise<GenerationSession> => {
    assertId(id);
    validateExpectedRevision(expectedRevision);
    await this.ensureGenerationRoot();
    return this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      if (!await pathExists(activeDirectory)) {
        if (await pathExists(this.finalDirectory(id))) {
          throw new GenerationSessionStoreError(
            "SESSION_PUBLISHED",
            `Published generation session cannot abort verification: ${id}`
          );
        }
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }
      const activeEvidence = await captureStoreDirectory(activeDirectory);
      const current = await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );
      if (current.revision !== expectedRevision) {
        throw new GenerationSessionStoreError(
          "REVISION_CONFLICT",
          `Expected generation revision ${String(expectedRevision)}, found ${
            String(current.revision)
          }`
        );
      }
      if (
        current.state !== "active"
        || current.inFlight !== null
        || current.pendingConfirmation !== null
        || current.verification.status !== "running"
        || current.publication.status !== "notRun"
      ) {
        throw new GenerationSessionStoreError(
          "INVALID_TRANSITION",
          "Verification abort requires an active running attempt"
        );
      }
      if (
        await pathExists(join(activeDirectory, "verification", "receipt.json"))
        || await pathExists(
          join(activeDirectory, "verification", "report.json")
        )
      ) {
        throw new GenerationSessionStoreError(
          "INVALID_TRANSITION",
          "Verification abort is forbidden after immutable evidence exists"
        );
      }
      const next = GenerationSessionSchema.parse({
        ...current,
        revision: current.revision + 1,
        verification: { status: "notRun" }
      });
      await writeStateAtomically(
        activeDirectory,
        next,
        this.syncDirectory,
        this.hooks.beforeStateRename,
        activeEvidence
      );
      return next;
    });
  };

  public readonly completeVerification = async (
    id: string,
    expectedRevision: number,
    input: GenerationSession
  ): Promise<void> => {
    await this.writeVerificationTransition(
      id,
      expectedRevision,
      input,
      "passed"
    );
  };

  public readonly failVerification = async (
    id: string,
    expectedRevision: number,
    input: GenerationSession
  ): Promise<void> => {
    await this.writeVerificationTransition(
      id,
      expectedRevision,
      input,
      "failed"
    );
  };

  public readonly recoverVerification = async (
    id: string,
    expectedRevision: number,
    input: GenerationSession
  ): Promise<void> => {
    assertId(id);
    const next = parseSession(input, true);
    validateNextRevision(id, expectedRevision, next);
    await this.ensureGenerationRoot();
    await this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      if (!await pathExists(activeDirectory)) {
        throw new GenerationSessionStoreError(
          await pathExists(this.finalDirectory(id))
            ? "SESSION_PUBLISHED"
            : "SESSION_NOT_FOUND",
          `Generation session cannot recover verification: ${id}`
        );
      }
      const activeEvidence = await captureStoreDirectory(activeDirectory);
      const current = await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );
      if (current.revision !== expectedRevision) {
        throw new GenerationSessionStoreError(
          "REVISION_CONFLICT",
          `Expected generation revision ${String(expectedRevision)}, found ${
            String(current.revision)
          }`
        );
      }
      if (
        await pathExists(join(activeDirectory, "verification", "receipt.json"))
        || await pathExists(
          join(activeDirectory, "verification", "report.json")
        )
      ) {
        throw new GenerationSessionStoreError(
          "INVALID_TRANSITION",
          "Verification recovery is forbidden after immutable evidence exists"
        );
      }
      assertVerificationRecoveryTransition(current, next);
      await writeStateAtomically(
        activeDirectory,
        next,
        this.syncDirectory,
        this.hooks.beforeStateRename,
        activeEvidence
      );
    });
  };

  public readonly reopenVerification = async (
    id: string,
    expectedRevision: number,
    input: GenerationSession
  ): Promise<void> => {
    assertId(id);
    const next = parseSession(input, true);
    validateNextRevision(id, expectedRevision, next);
    await this.ensureGenerationRoot();
    await this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      if (!await pathExists(activeDirectory)) {
        throw new GenerationSessionStoreError(
          await pathExists(this.finalDirectory(id))
            ? "SESSION_PUBLISHED"
            : "SESSION_NOT_FOUND",
          `Generation session cannot reopen verification: ${id}`
        );
      }
      const activeEvidence = await captureStoreDirectory(activeDirectory);
      const current = await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );
      if (current.revision !== expectedRevision) {
        throw new GenerationSessionStoreError(
          "REVISION_CONFLICT",
          `Expected generation revision ${String(expectedRevision)}, found ${
            String(current.revision)
          }`
        );
      }
      assertVerificationReopenTransition(current, next);
      await writeStateAtomically(
        activeDirectory,
        next,
        this.syncDirectory,
        this.hooks.beforeStateRename,
        activeEvidence
      );
    });
  };

  public readonly markBundlePublishable = async (
    id: string,
    expectedRevision: number,
    input: GenerationSession
  ): Promise<void> => {
    assertId(id);
    const next = parseSession(input, true);
    validateNextRevision(id, expectedRevision, next);
    await this.ensureGenerationRoot();
    await this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      if (!await pathExists(activeDirectory)) {
        if (await pathExists(this.finalDirectory(id))) {
          throw new GenerationSessionStoreError(
            "SESSION_PUBLISHED",
            `Published generation session cannot be marked publishable: ${id}`
          );
        }
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }
      const activeEvidence = await captureStoreDirectory(activeDirectory);
      const current = await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );
      if (current.revision !== expectedRevision) {
        throw new GenerationSessionStoreError(
          "REVISION_CONFLICT",
          `Expected generation revision ${String(expectedRevision)}, found ${
            String(current.revision)
          }`
        );
      }
      assertBundlePublishableTransition(current, next);
      await writeStateAtomically(
        activeDirectory,
        next,
        this.syncDirectory,
        this.hooks.beforeStateRename,
        activeEvidence
      );
    });
  };

  public readonly archive = async (
    id: string,
    expectedRevision: number,
    input: GenerationSession
  ): Promise<void> => {
    assertId(id);
    const next = parseSession(input, true);
    validateNextRevision(id, expectedRevision, next);
    await this.ensureGenerationRoot();
    await this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      if (!await pathExists(activeDirectory)) {
        if (await pathExists(this.finalDirectory(id))) {
          throw new GenerationSessionStoreError(
            "SESSION_PUBLISHED",
            `Published generation session cannot be archived: ${id}`
          );
        }
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }
      const activeEvidence = await captureStoreDirectory(activeDirectory);
      const current = await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );
      if (current.revision !== expectedRevision) {
        throw new GenerationSessionStoreError(
          "REVISION_CONFLICT",
          `Expected generation revision ${String(expectedRevision)}, found ${
            String(current.revision)
          }`
        );
      }
      assertArchiveTransition(current, next);
      await writeStateAtomically(
        activeDirectory,
        next,
        this.syncDirectory,
        this.hooks.beforeStateRename,
        activeEvidence
      );
    });
  };

  public readonly list = async (): Promise<readonly GenerationSession[]> => {
    await this.ensureGenerationRoot();
    const entries = await readdir(this.generationRoot, {
      withFileTypes: true
    });
    const sessions: GenerationSession[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".locks") {
        continue;
      }
      const directory = join(this.generationRoot, entry.name);
      const statePath = join(directory, "state.json");
      if (!await pathExists(statePath)) {
        continue;
      }
      const session = await readStateFromDirectory(directory);
      sessions.push(session);
    }
    return sessions.sort((left, right) => left.id.localeCompare(right.id));
  };

  public readonly writeEvidence = async (
    id: string,
    relativePath: string,
    value: unknown
  ): Promise<void> => {
    const canonicalValue = canonicalizeEvidence(value);
    await this.produceEvidence(id, relativePath, async (temporaryPath) => {
      const handle = await open(
        temporaryPath,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_EXCL
          | constants.O_NOFOLLOW,
        0o600
      );
      try {
        await handle.writeFile(serializeJson(canonicalValue), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  };

  public readonly writeTextEvidence = async (
    id: string,
    relativePath: string,
    value: string
  ): Promise<void> => {
    if (typeof value !== "string") {
      throw new GenerationSessionStoreError(
        "INVALID_EVIDENCE",
        "Text evidence must be a string"
      );
    }
    await this.produceEvidence(id, relativePath, async (temporaryPath) => {
      const handle = await open(
        temporaryPath,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_EXCL
          | constants.O_NOFOLLOW,
        0o600
      );
      try {
        await handle.writeFile(value, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  };

  public readonly produceEvidence = async (
    id: string,
    relativePath: string,
    produce: (temporaryPath: string) => Promise<void>
  ): Promise<void> => {
    assertId(id);
    const segments = validateEvidencePath(relativePath);
    if (typeof produce !== "function") {
      throw new GenerationSessionStoreError(
        "INVALID_EVIDENCE",
        "Evidence producer must be a function"
      );
    }
    await this.ensureGenerationRoot();

    await this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      if (!await pathExists(activeDirectory)) {
        if (await pathExists(this.finalDirectory(id))) {
          throw new GenerationSessionStoreError(
            "SESSION_PUBLISHED",
            `Published generation session cannot accept evidence: ${id}`
          );
        }
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }
      const activeEvidence = await captureStoreDirectory(activeDirectory);
      const state = await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );
      if (state.publication.status === "published") {
        throw new GenerationSessionStoreError(
          "SESSION_PUBLISHED",
          `Publishable generation session cannot accept evidence: ${id}`
        );
      }

      let parent = activeDirectory;
      const directoryEvidence: DirectoryEvidence[] = [
        activeEvidence
      ];
      for (const segment of segments.slice(0, -1)) {
        await verifyStoreDirectory(activeEvidence);
        const parentBeforeCreation = parent;
        parent = join(parentBeforeCreation, segment);
        try {
          const created = await createOrRequireDirectory(parent);
          if (created) {
            await this.syncDirectory(parent);
            await this.syncDirectory(parentBeforeCreation);
          }
          directoryEvidence.push(await captureDirectoryEvidence(parent));
        } catch (error) {
          throw new GenerationSessionStoreError(
            "INVALID_EVIDENCE_PATH",
            `Evidence parent is not a safe directory: ${relativePath}`,
            { cause: error }
          );
        }
      }
      const realActive = directoryEvidence[0]?.canonicalPath;
      if (realActive === undefined) {
        throw new GenerationSessionStoreError(
          "INVALID_EVIDENCE_PATH",
          "Generation active directory identity is unavailable"
        );
      }
      await verifyDirectoryEvidence(realActive, directoryEvidence);

      const outputPath = join(parent, segments.at(-1) as string);
      assertContained(activeDirectory, outputPath);
      const temporaryPath = join(
        activeDirectory,
        `.producer-${randomUUID()}.tmp`
      );
      let installed = false;
      let committed = false;
      try {
        await verifyStoreDirectory(activeEvidence);
        await produce(temporaryPath);
        const temporaryIdentity = await fileIdentity(temporaryPath);
        const handle = await open(
          temporaryPath,
          constants.O_RDONLY | constants.O_NOFOLLOW
        );
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        await this.hooks.beforeEvidenceInstall?.();
        await verifyDirectoryEvidence(realActive, directoryEvidence);
        await link(temporaryPath, outputPath);
        installed = true;
        const installedIdentity = await fileIdentity(outputPath);
        await verifyDirectoryEvidence(realActive, directoryEvidence);
        if (
          installedIdentity.dev !== temporaryIdentity.dev
          || installedIdentity.ino !== temporaryIdentity.ino
        ) {
          throw new GenerationSessionStoreError(
            "INVALID_EVIDENCE_PATH",
            `Evidence output identity changed: ${relativePath}`
          );
        }
        await this.syncDirectory(parent);
        committed = true;
        await this.hooks.afterEvidenceInstall?.();
      } catch (error) {
        if (installed && !committed) {
          try {
            const currentIdentity = await fileIdentity(outputPath);
            const temporaryIdentity = await fileIdentity(temporaryPath);
            if (
              currentIdentity.dev === temporaryIdentity.dev
              && currentIdentity.ino === temporaryIdentity.ino
            ) {
              await unlink(outputPath);
              await this.syncDirectory(parent);
            }
          } catch {
            // Preserve any path that cannot be proven to be our own link.
          }
        }
        if (isErrnoException(error) && error.code === "EEXIST") {
          throw new GenerationSessionStoreError(
            "EVIDENCE_ALREADY_EXISTS",
            `Generation evidence already exists: ${relativePath}`,
            { cause: error }
          );
        }
        throw error;
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
    });
  };

  public readonly readEvidence = async (
    id: string,
    relativePath: string
  ): Promise<Buffer> => {
    return this.withVerifiedEvidence(
      id,
      relativePath,
      ({ handle }) => handle.readFile()
    );
  };

  public readonly evidenceReference = async (
    id: string,
    relativePath: string
  ): Promise<string> => {
    return this.withVerifiedEvidence(
      id,
      relativePath,
      ({ published, segments }) => (
        `${GENERATIONS_DIR}/${
          published ? id : activeBundleName(id)
        }/${segments.join("/")}`
      )
    );
  };

  public readonly listEvidence = async (
    id: string
  ): Promise<readonly {
    path: string;
    contentBase64: string;
    byteLength: number;
  }[]> => {
    assertId(id);
    await this.ensureGenerationRoot();
    return this.withLock(id, async () => {
      const finalDirectory = this.finalDirectory(id);
      const activeDirectory = this.activeDirectory(id);
      const directory = await pathExists(finalDirectory)
        ? finalDirectory
        : activeDirectory;
      if (!await pathExists(directory)) {
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }
      const rootEvidence = await captureStoreDirectory(directory);
      await readBoundState(
        directory,
        id,
        this.hooks.afterStateOpen,
        rootEvidence
      );
      const files: {
        path: string;
        contentBase64: string;
        byteLength: number;
      }[] = [];

      const visit = async (
        currentPath: string,
        segments: readonly string[],
        expectedIdentity?: FileIdentity
      ): Promise<void> => {
        const initialDirectoryStats = await lstat(currentPath, {
          bigint: true
        });
        if (!initialDirectoryStats.isDirectory()) {
          throw new GenerationSessionStoreError(
            "INVALID_EVIDENCE_PATH",
            `Generation evidence directory changed type: ${segments.join("/")}`
          );
        }
        const initialDirectoryMetadata = snapshotMetadata(
          initialDirectoryStats
        );
        const directoryEvidence = await captureStoreDirectory(currentPath);
        if (
          expectedIdentity !== undefined
          && !sameIdentity(directoryEvidence.identity, expectedIdentity)
        ) {
          throw new GenerationSessionStoreError(
            "INVALID_EVIDENCE_PATH",
            `Generation evidence directory identity changed: ${
              segments.join("/")
            }`
          );
        }
        assertContained(rootEvidence.canonicalPath, directoryEvidence.canonicalPath, true);
        const entries = (await readdir(currentPath, { withFileTypes: true }))
          .sort((left, right) => left.name.localeCompare(right.name));
        const initialEntries = evidenceEntrySnapshot(entries);
        await this.hooks.afterEvidenceDirectoryRead?.(
          segments.join("/"),
          "beforeTraversal"
        );
        for (const entry of entries) {
          const childSegments = [...segments, entry.name];
          const relativePath = childSegments.join("/");
          if (
            segments.length === 0
            && (entry.name === "state.json" || entry.name === "manifest.json")
          ) {
            continue;
          }
          const childPath = join(currentPath, entry.name);
          let stats: BigIntStats;
          try {
            stats = await lstat(childPath, { bigint: true });
          } catch (error) {
            if (isErrnoException(error) && error.code === "ENOENT") {
              throw new GenerationSessionStoreError(
                "INVALID_EVIDENCE_PATH",
                `Generation evidence disappeared during snapshot: ${
                  relativePath
                }`
              );
            }
            throw error;
          }
          if (stats.isSymbolicLink()) {
            throw new GenerationSessionStoreError(
              "INVALID_EVIDENCE_PATH",
              `Generation evidence contains a symbolic link: ${relativePath}`
            );
          }
          if (stats.isDirectory()) {
            await visit(
              childPath,
              childSegments,
              { dev: stats.dev, ino: stats.ino }
            );
            continue;
          }
          if (!stats.isFile()) {
            throw new GenerationSessionStoreError(
              "INVALID_EVIDENCE_PATH",
              `Generation evidence is not a regular file: ${relativePath}`
            );
          }
          const handle = await open(
            childPath,
            constants.O_RDONLY | constants.O_NOFOLLOW
          );
          try {
            const opened = await handle.stat({ bigint: true });
            const initialFileMetadata = snapshotMetadata(opened);
            if (
              !opened.isFile()
              || !sameSnapshotMetadata(
                snapshotMetadata(stats),
                initialFileMetadata
              )
            ) {
              throw new GenerationSessionStoreError(
                "INVALID_EVIDENCE_PATH",
                `Generation evidence changed before read: ${relativePath}`
              );
            }
            await this.hooks.afterEvidenceOpen?.(relativePath);
            await verifyStoreDirectory(rootEvidence);
            await verifyStoreDirectory(directoryEvidence);
            const bytes = await handle.readFile();
            await this.hooks.afterEvidenceRead?.(relativePath);
            const finalDescriptorStats = await handle.stat({ bigint: true });
            const finalPathStats = await lstat(childPath, { bigint: true });
            if (
              !finalDescriptorStats.isFile()
              || !finalPathStats.isFile()
              || !sameSnapshotMetadata(
                initialFileMetadata,
                snapshotMetadata(finalDescriptorStats)
              )
              || !sameSnapshotMetadata(
                initialFileMetadata,
                snapshotMetadata(finalPathStats)
              )
            ) {
              throw new GenerationSessionStoreError(
                "INVALID_EVIDENCE_PATH",
                `Generation evidence changed during read: ${relativePath}`
              );
            }
            files.push({
              path: relativePath,
              contentBase64: bytes.toString("base64"),
              byteLength: bytes.byteLength
            });
          } finally {
            await handle.close();
          }
        }
        await this.hooks.afterEvidenceDirectoryRead?.(
          segments.join("/"),
          "afterTraversal"
        );
        const finalEntriesRaw = await readdir(currentPath, {
          withFileTypes: true
        });
        const finalDirectoryStats = await lstat(currentPath, {
          bigint: true
        });
        const finalEntries = evidenceEntrySnapshot(finalEntriesRaw);
        if (
          !finalDirectoryStats.isDirectory()
          || !sameSnapshotMetadata(
            initialDirectoryMetadata,
            snapshotMetadata(finalDirectoryStats)
          )
          || initialEntries.length !== finalEntries.length
          || initialEntries.some((
            entry,
            index
          ) => entry !== finalEntries[index])
        ) {
          throw new GenerationSessionStoreError(
            "INVALID_EVIDENCE_PATH",
            `Generation evidence directory changed during snapshot: ${
              segments.join("/")
            }`
          );
        }
        await verifyStoreDirectory(rootEvidence);
        await verifyStoreDirectory(directoryEvidence);
      };

      await visit(directory, []);
      return files.sort((left, right) => compareStrings(left.path, right.path));
    });
  };

  public readonly publish = async (id: string): Promise<string> => {
    assertId(id);
    await this.ensureGenerationRoot();
    return this.withLock(id, async () => {
      const generationRootEvidence = await captureStoreDirectory(
        this.generationRoot
      );
      const activeDirectory = this.activeDirectory(id);
      const finalDirectory = this.finalDirectory(id);
      const activeExists = await pathExists(activeDirectory);
      const finalExists = await pathExists(finalDirectory);

      if (finalExists && !activeExists) {
        const finalEvidence = await captureStoreDirectory(finalDirectory);
        const state = await readBoundState(
          finalDirectory,
          id,
          this.hooks.afterStateOpen,
          finalEvidence
        );
        this.assertPublishable(state);
        await this.syncDirectory(this.generationRoot);
        return finalDirectory;
      }
      if (finalExists) {
        throw new GenerationSessionStoreError(
          "PUBLISH_DESTINATION_EXISTS",
          `Generation publish destination already exists: ${finalDirectory}`
        );
      }
      if (!activeExists) {
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }

      const activeEvidence = await captureStoreDirectory(activeDirectory);
      const state = await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );
      this.assertPublishable(state);
      try {
        await this.hooks.beforePublishRename?.();
        await verifyStoreDirectory(generationRootEvidence);
        await verifyStoreDirectory(activeEvidence);
        await rename(activeDirectory, finalDirectory);
        const finalEvidence = await captureStoreDirectory(finalDirectory);
        if (!sameIdentity(activeEvidence.identity, finalEvidence.identity)) {
          throw new GenerationSessionStoreError(
            "IO_ERROR",
            "Published generation bundle identity changed"
          );
        }
      } catch (error) {
        if (
          isErrnoException(error)
          && (
            error.code === "EEXIST"
            || error.code === "ENOTEMPTY"
          )
        ) {
          throw new GenerationSessionStoreError(
            "PUBLISH_DESTINATION_EXISTS",
            `Generation publish destination already exists: ${finalDirectory}`,
            { cause: error }
          );
        }
        throw error;
      }
      await this.syncDirectory(this.generationRoot);
      return finalDirectory;
    });
  };

  private readonly ensureGenerationRoot = async (): Promise<void> => {
    try {
      if (this.customGenerationRoot) {
        await mkdir(dirname(this.generationRoot), { recursive: true });
        await createOrRequireDirectory(this.generationRoot);
        await createOrRequireDirectory(this.locksRoot);
        return;
      }
      await requireRealDirectory(this.projectRoot);
      const taphoundDirectory = join(this.projectRoot, TAPHOUND_DIR);
      if (await createOrRequireDirectory(taphoundDirectory)) {
        await this.syncDirectory(this.projectRoot);
      }
      const buildDirectory = join(this.projectRoot, BUILD_DIR);
      if (await createOrRequireDirectory(buildDirectory)) {
        await this.syncDirectory(taphoundDirectory);
      }
      if (await createOrRequireDirectory(this.generationRoot)) {
        await this.syncDirectory(buildDirectory);
      }
      if (await createOrRequireDirectory(this.locksRoot)) {
        await this.syncDirectory(this.generationRoot);
      }
      await ensureBuildIgnored(this.projectRoot);
    } catch (error) {
      throw asStoreIoError(error, "initialize its generation directory");
    }
  };

  private readonly writeVerificationTransition = async (
    id: string,
    expectedRevision: number,
    input: GenerationSession,
    status: "passed" | "failed"
  ): Promise<void> => {
    assertId(id);
    const next = parseSession(input, true);
    validateNextRevision(id, expectedRevision, next);
    await this.ensureGenerationRoot();
    await this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      if (!await pathExists(activeDirectory)) {
        if (await pathExists(this.finalDirectory(id))) {
          throw new GenerationSessionStoreError(
            "SESSION_PUBLISHED",
            `Published generation session cannot complete verification: ${id}`
          );
        }
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }
      const activeEvidence = await captureStoreDirectory(activeDirectory);
      const current = await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );
      if (current.revision !== expectedRevision) {
        throw new GenerationSessionStoreError(
          "REVISION_CONFLICT",
          `Expected generation revision ${String(expectedRevision)}, found ${
            String(current.revision)
          }`
        );
      }
      assertVerificationCompletionTransition(current, next, status);
      await writeStateAtomically(
        activeDirectory,
        next,
        this.syncDirectory,
        this.hooks.beforeStateRename,
        activeEvidence
      );
    });
  };

  private readonly activeDirectory = (id: string): string => (
    join(this.generationRoot, activeBundleName(id))
  );

  private readonly finalDirectory = (id: string): string => (
    join(this.generationRoot, id)
  );

  private readonly withVerifiedEvidence = async <T>(
    id: string,
    relativePath: string,
    operation: (input: {
      handle: Awaited<ReturnType<typeof open>>;
      published: boolean;
      segments: readonly string[];
    }) => Promise<T> | T
  ): Promise<T> => {
    assertId(id);
    const segments = validateEvidencePath(relativePath);
    await this.ensureGenerationRoot();
    return this.withLock(id, async () => {
      const finalDirectory = this.finalDirectory(id);
      const activeDirectory = this.activeDirectory(id);
      const published = await pathExists(finalDirectory);
      const directory = published ? finalDirectory : activeDirectory;
      if (!await pathExists(directory)) {
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }
      const rootEvidence = await captureStoreDirectory(directory);
      await readBoundState(
        directory,
        id,
        this.hooks.afterStateOpen,
        rootEvidence
      );
      let current = directory;
      const directories: DirectoryEvidence[] = [rootEvidence];
      for (const segment of segments.slice(0, -1)) {
        current = join(current, segment);
        let evidence: DirectoryEvidence;
        try {
          evidence = await captureDirectoryEvidence(current);
        } catch (error) {
          if (isErrnoException(error) && error.code === "ENOENT") {
            throw evidenceNotFound(relativePath, error);
          }
          throw error;
        }
        assertContained(rootEvidence.canonicalPath, evidence.canonicalPath);
        directories.push(evidence);
      }
      const path = join(current, segments.at(-1) as string);
      assertContained(directory, path);
      await verifyDirectoryEvidence(rootEvidence.canonicalPath, directories);
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW
        );
      } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") {
          throw evidenceNotFound(relativePath, error);
        }
        throw error;
      }
      try {
        const stats = await handle.stat({ bigint: true });
        if (!stats.isFile()) {
          throw new GenerationSessionStoreError(
            "INVALID_EVIDENCE_PATH",
            `Evidence is not a regular file: ${relativePath}`
          );
        }
        const openedIdentity = { dev: stats.dev, ino: stats.ino };
        const pathIdentity = await fileIdentity(path);
        if (!sameIdentity(openedIdentity, pathIdentity)) {
          throw new GenerationSessionStoreError(
            "INVALID_EVIDENCE_PATH",
            `Evidence file identity changed: ${relativePath}`
          );
        }
        await verifyDirectoryEvidence(rootEvidence.canonicalPath, directories);
        return await operation({ handle, published, segments });
      } finally {
        await handle.close();
      }
    });
  };

  private readonly withLock = <T>(
    id: string,
    operation: () => Promise<T>
  ): Promise<T> => this.lock.withLock(id, operation);

  private readonly syncDirectory = async (path: string): Promise<void> => {
    await syncDirectory(path);
    await this.hooks.afterDirectorySync?.(path);
  };

  private assertPublishable(session: GenerationSession): void {
    if (
      session.verification.status !== "passed"
      || session.publication.status !== "published"
      || session.inFlight !== null
      || session.pendingConfirmation !== null
    ) {
      throw new GenerationSessionStoreError(
        "SESSION_NOT_PUBLISHABLE",
        "Generation session is not ready to publish"
      );
    }
  }
}
