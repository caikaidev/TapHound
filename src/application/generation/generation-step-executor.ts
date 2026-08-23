import { createHash } from "node:crypto";

import { z } from "zod";

import {
  appProcessPids,
  primaryAppPid
} from "../../domain/app-process.js";
import {
  GenerationSessionSchema,
  GenerationInFlightSchema,
  expandProposedStepVariables,
  hashGenerationConfirmationEvidence,
  isGenerationConfirmationExpired,
  type GenerationInFlight,
  type GenerationSession,
  type PendingConfirmation
} from "../../domain/generation.js";
import { JourneyStepSchema, type JourneyStep } from "../../domain/journey.js";
import type { LayoutElement } from "../../domain/layout.js";
import { assessWindowHierarchy } from "../../domain/window-hierarchy.js";
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
import type { AdbPort } from "../../ports/adb.js";
import type { AndroidCliPort } from "../../ports/android-cli.js";
import type { Clock } from "../../ports/clock.js";
import type { GenerationSessionStore } from "../../ports/generation-session-store.js";
import {
  isKnownSystemPackage,
  isSystemScenario
} from "../../domain/system-app-profiles.js";
import {
  ExpectationEvaluator,
  type ExpectationObservationInput
} from "../assertion/expectation-evaluator.js";
import { LogcatCollector } from "../collector/logcat-collector.js";
import { logcatStopFailed } from "../collector/logcat-stop.js";
import { ActionExecutor, type ActionTarget } from "../interaction/action-executor.js";
import { ScrollToExecutor } from "../interaction/scroll-to-executor.js";
import { resolveLocator } from "../locator/locator-resolver.js";
import {
  IdleWaiter,
  type IdleConfig,
  type IdleResult
} from "../wait/idle-waiter.js";
import {
  summarizeProposedStep
} from "./generation-confirmation-service.js";
import { GenerationOperationError } from "./generation-starter.js";
import type { SnapshotReobservationGuard } from "./runtime-observer.js";
import type {
  CollectedRuntimeState,
  RuntimeObservation
} from "./runtime-observer.js";
import { RiskEvaluator } from "./risk-evaluator.js";
import {
  hasExactlyOneEnabledFocusedElement
} from "./focused-input.js";

export type GenerationCandidateSource = "planner" | "manualOverride";

export interface GenerationStepExecutionInput {
  generationId: string;
  proposal: ProposedStep;
  snapshot: RuntimeSnapshot;
  source: GenerationCandidateSource;
  signal?: AbortSignal | undefined;
}

export interface GenerationStepFailure {
  code: string;
  message: string;
  details?: unknown;
}

export interface GenerationStepTiming {
  freshnessCheckMs: number;
  evidenceSetupMs: number;
  logcatStartMs: number;
  preActionObservationMs: number;
  actionExecutionMs: number;
  idleWaitMs: number;
  postActionObservationMs: number;
  expectationMs: number;
  logcatStopMs: number;
  totalMs: number;
  nextObservationMs?: number | undefined;
}

export type GenerationStepExecutionResult =
  | {
      status: "succeeded";
      step: JourneyStep;
      timing?: GenerationStepTiming | undefined;
      nextObservation?: RuntimeObservation | undefined;
      nextObservationFailure?: GenerationStepFailure | undefined;
    }
  | {
      status: "failed";
      failure: GenerationStepFailure;
      timing?: GenerationStepTiming | undefined;
    }
  | {
      status: "cancelled";
      failure: GenerationStepFailure;
      timing?: GenerationStepTiming | undefined;
    };

export interface GenerationStepExecutorDependencies {
  store: Pick<
    GenerationSessionStore,
    | "read"
    | "beginStep"
    | "completeStep"
    | "update"
    | "writeEvidence"
    | "writeTextEvidence"
  >;
  freshnessGuard: Pick<SnapshotReobservationGuard, "assertFresh">;
  adb: AdbPort;
  androidCli: AndroidCliPort;
  clock: Clock;
  idle: IdleConfig;
  now: () => Date;
  generateAttemptId: () => string;
  clearApprovedConfirmation: (
    generationId: string,
    challenge: PendingConfirmation
  ) => Promise<void>;
  observeNext?: (input: {
    generationId: string;
    runtime: CollectedRuntimeState;
    signal?: AbortSignal | undefined;
  }) => Promise<RuntimeObservation>;
}

interface LiveRuntime {
  foregroundPackageName: string;
  activity: string;
  pid: number;
  pids: readonly number[];
  layout: readonly LayoutElement[];
  windowHierarchy: ReturnType<typeof assessWindowHierarchy>;
}

class StepCancelledError extends Error {
  public override readonly name = "StepCancelledError";
}

function cancellation(): GenerationStepExecutionResult {
  return {
    status: "cancelled",
    failure: {
      code: "RECOVERY_REQUIRED",
      message: "Step was cancelled"
    }
  };
}

function isCancelled(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (isCancelled(signal)) {
    throw new StepCancelledError("Step was cancelled");
  }
}

function executionPath(
  inFlight: GenerationInFlight,
  suffix: string
): string {
  return `evidence/steps/${String(inFlight.stepIndex)}-${
    inFlight.attemptId
  }/${suffix}`;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalEvidenceBytes(value: unknown): Buffer {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.keys(input)
          .sort((left, right) => left.localeCompare(right))
          .map((key) => [
            key,
            canonicalize((input as Record<string, unknown>)[key])
          ])
      );
    }
    return input;
  };
  return Buffer.from(`${JSON.stringify(canonicalize(value), null, 2)}\n`);
}

function asFailure(error: unknown): GenerationStepFailure {
  if (
    error !== null
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
  ) {
    return {
      code: error.code,
      message: error instanceof Error ? error.message : error.code,
      ...("details" in error ? { details: error.details } : {})
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "Unknown step failure"
  };
}

function fail(code: string, message: string, details?: unknown): never {
  throw Object.assign(
    new Error(message),
    { code, ...(details === undefined ? {} : { details }) }
  );
}

function idleTimeoutDetails(
  idle: Extract<IdleResult, { status: "timeout" }>
): Record<string, unknown> {
  return {
    idle: {
      strategy: idle.strategy,
      ...(idle.backend === undefined ? {} : { backend: idle.backend }),
      polls: idle.polls,
      durationMs: idle.durationMs,
      samplingDurationMs: idle.samplingDurationMs,
      fallbackUsed: idle.fallbackUsed,
      frameActivityDetected: idle.frameActivityDetected,
      lastDiff: idle.lastDiff
    }
  };
}

function sameSession(
  left: GenerationSession,
  right: GenerationSession
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactApprovedChallenge(
  session: GenerationSession,
  proposal: ProposedStep,
  snapshot: RuntimeSnapshot,
  source: GenerationCandidateSource,
  now: Date
): PendingConfirmation {
  const challenge = session.pendingConfirmation;
  if (
    challenge === null
    || challenge.status !== "approved"
    || session.revision !== proposal.binding.baseRevision + 2
    || challenge.stepIndex !== session.candidateSteps.length
    || challenge.proposalHash !== hashProposedStep(proposal)
    || challenge.snapshotHash !== hashRuntimeSnapshot(snapshot)
    || challenge.snapshotHash !== proposal.binding.snapshotHash
    || challenge.evidenceHash !== hashGenerationConfirmationEvidence({
      version: 1,
      proposal,
      snapshot,
      source
    })
    || challenge.actionSummary !== summarizeProposedStep(proposal)
    || isGenerationConfirmationExpired(challenge, now)
  ) {
    throw new GenerationOperationError(
      "RISK_CONFIRMATION_REQUIRED",
      "An exact non-expired approved confirmation is required"
    );
  }
  return challenge;
}

function isBoundApprovedChallenge(
  challenge: PendingConfirmation | null,
  session: GenerationSession,
  proposal: ProposedStep,
  snapshot: RuntimeSnapshot
): challenge is PendingConfirmation {
  return challenge !== null
    && challenge.status === "approved"
    && challenge.stepIndex === session.candidateSteps.length
    && challenge.proposalHash === hashProposedStep(proposal)
    && challenge.snapshotHash === hashRuntimeSnapshot(snapshot)
    && challenge.snapshotHash === proposal.binding.snapshotHash
    && challenge.actionSummary === summarizeProposedStep(proposal);
}

function assertBaseAuthorization(
  session: GenerationSession,
  proposal: ProposedStep,
  snapshot: RuntimeSnapshot
): void {
  if (
    session.id !== proposal.binding.generationId
    || session.id !== snapshot.generationId
    || proposal.binding.generationId !== snapshot.generationId
    || proposal.binding.baseRevision !== snapshot.baseRevision
    || proposal.binding.snapshotHash !== hashRuntimeSnapshot(snapshot)
    || proposal.binding.snapshotHash !== session.bindings.snapshotHash
    || snapshot.expectedPackageName !== session.target.packageName
    || snapshot.deviceSerial !== session.target.deviceSerial
    || snapshot.activity !== proposal.activity.before
    || session.state !== "active"
    || session.inFlight !== null
    || session.verification.status !== "notRun"
    || session.publication.status !== "notRun"
  ) {
    throw new GenerationOperationError(
      "SNAPSHOT_STALE",
      "Proposal is not bound to the authoritative generation snapshot"
    );
  }
}

function executableStep(
  proposal: ProposedStep,
  variables: GenerationSession["variables"],
  after: string,
  extra?: Record<string, unknown>
): JourneyStep {
  const expanded = expandProposedStepVariables(proposal, variables);
  const action = Object.fromEntries(
    Object.entries(expanded).filter(
      ([key]) => key !== "binding" && key !== "activity"
    )
  );
  return JourneyStepSchema.parse({
    ...action,
    ...(extra === undefined ? {} : extra),
    activity: {
      before: expanded.activity.before,
      after
    }
  });
}

function requireTarget(
  layout: readonly LayoutElement[],
  step: JourneyStep
): ActionTarget | undefined {
  if (
    step.action !== "click"
    && step.action !== "longClick"
    && step.action !== "swipe"
  ) {
    return undefined;
  }
  const resolution = resolveLocator(layout, step.locator, {
    ...(step.action === "click" ? { requiredCapability: "clickable" } : {}),
    ...(step.action === "longClick"
      ? { requiredCapability: "longClickable" }
      : {})
  });
  if (resolution.status !== "found") {
    fail(resolution.code, resolution.message);
  }
  if (step.action === "click" && resolution.element.clickable !== true) {
    fail("ACTION_FAILED", "click target is not clickable");
  }
  if (
    step.action === "longClick"
    && resolution.element.longClickable !== true
  ) {
    fail("ACTION_FAILED", "longClick target is not longClickable");
  }
  if (
    step.action === "swipe"
    && (
      resolution.element.scrollable !== true
      || resolution.element.bounds === undefined
    )
  ) {
    fail("ACTION_FAILED", "swipe target lacks scrollable bounds");
  }
  return {
    point: resolution.point,
    ...(resolution.element.bounds === undefined
      ? {}
      : { bounds: resolution.element.bounds })
  };
}

function requireBridgeTrigger(
  layout: readonly LayoutElement[],
  step: Extract<JourneyStep, { action: "bridge" }>
): ActionTarget {
  const resolution = resolveLocator(layout, step.triggerLocator, {
    requiredCapability: "clickable"
  });
  if (resolution.status !== "found") {
    fail(resolution.code, resolution.message);
  }
  if (resolution.element.clickable !== true) {
    fail("ACTION_FAILED", "bridge trigger target is not clickable");
  }
  return {
    point: resolution.point,
    ...(resolution.element.bounds === undefined
      ? {}
      : { bounds: resolution.element.bounds })
  };
}

export class GenerationStepExecutor {
  private readonly riskEvaluator = new RiskEvaluator();

  public constructor(
    private readonly dependencies: GenerationStepExecutorDependencies
  ) {}

  public readonly execute = async (
    input: GenerationStepExecutionInput
  ): Promise<GenerationStepExecutionResult> => {
    const executionStartedAt = this.dependencies.clock.now();
    const timing: GenerationStepTiming = {
      freshnessCheckMs: 0,
      evidenceSetupMs: 0,
      logcatStartMs: 0,
      preActionObservationMs: 0,
      actionExecutionMs: 0,
      idleWaitMs: 0,
      postActionObservationMs: 0,
      expectationMs: 0,
      logcatStopMs: 0,
      totalMs: 0
    };
    const proposal = ProposedStepSchema.parse(input.proposal);
    const snapshot = RuntimeSnapshotSchema.parse(input.snapshot);
    const source = z.enum(["planner", "manualOverride"]).parse(input.source);
    const session = GenerationSessionSchema.parse(
      await this.dependencies.store.read(input.generationId)
    );
    assertBaseAuthorization(session, proposal, snapshot);
    const risk = this.riskEvaluator.evaluate(
      proposal,
      session.target.interactionPolicy,
      snapshot
    );
    if (risk.effectiveRisk === "forbidden") {
      throw new GenerationOperationError(
        "ACTION_FORBIDDEN",
        `${proposal.action} is forbidden by the Core interaction policy`
      );
    }
    let approved: PendingConfirmation | undefined;
    if (risk.effectiveRisk === "confirmationRequired") {
      try {
        approved = exactApprovedChallenge(
          session,
          proposal,
          snapshot,
          source,
          this.dependencies.now()
        );
      } catch (error) {
        if (isBoundApprovedChallenge(
          session.pendingConfirmation,
          session,
          proposal,
          snapshot
        )) {
          await this.dependencies.clearApprovedConfirmation(
            session.id,
            session.pendingConfirmation
          );
        }
        throw error;
      }
    } else if (
      session.revision !== proposal.binding.baseRevision
      || session.pendingConfirmation !== null
    ) {
      throw new GenerationOperationError(
        "SNAPSHOT_STALE",
        "Safe proposal revision is no longer current"
      );
    }

    const clearApproved = async (): Promise<void> => {
      if (approved !== undefined) {
        await this.dependencies.clearApprovedConfirmation(
          session.id,
          approved
        );
      }
    };
    if (isCancelled(input.signal)) {
      await clearApproved();
      return cancellation();
    }
    let fresh: RuntimeSnapshot;
    try {
      const freshnessStartedAt = this.dependencies.clock.now();
      fresh = await this.dependencies.freshnessGuard.assertFresh(
        proposal.binding,
        input.signal,
        approved
      );
      timing.freshnessCheckMs = (
        this.dependencies.clock.now() - freshnessStartedAt
      );
    } catch (error) {
      await clearApproved();
      if (isCancelled(input.signal)) {
        return cancellation();
      }
      throw error;
    }
    if (isCancelled(input.signal)) {
      await clearApproved();
      return cancellation();
    }
    if (fresh.foregroundPackageName !== session.target.packageName) {
      await clearApproved();
      throw new GenerationOperationError(
        "PACKAGE_ESCAPE",
        "Fresh foreground package escaped the generation target"
      );
    }
    if (fresh.pid === null) {
      await clearApproved();
      throw new GenerationOperationError(
        "APP_CRASHED",
        "Fresh generation process is not running"
      );
    }
    if (fresh.activity !== proposal.activity.before) {
      await clearApproved();
      throw new GenerationOperationError(
        "SNAPSHOT_STALE",
        "Fresh Activity does not match the accepted proposal"
      );
    }
    const authoritativePid = fresh.pid;

    let inFlight: GenerationInFlight;
    try {
      inFlight = GenerationInFlightSchema.parse({
        stepIndex: session.candidateSteps.length,
        snapshotHash: proposal.binding.snapshotHash,
        proposalHash: hashProposedStep(proposal),
        attemptId: this.dependencies.generateAttemptId(),
        ...(approved === undefined
          ? {}
          : {
              confirmation: {
                challengeId: approved.challengeId,
                approvalMode: approved.approvalMode ?? "localTty"
              }
            })
      });
    } catch (error) {
      await clearApproved();
      throw error;
    }
    if (isCancelled(input.signal)) {
      await clearApproved();
      return cancellation();
    }
    let begun: GenerationSession;
    try {
      begun = await this.dependencies.store.beginStep(
        session.id,
        session.revision,
        inFlight,
        approved
      );
    } catch (error) {
      const latest = GenerationSessionSchema.parse(
        await this.dependencies.store.read(session.id)
      );
      if (JSON.stringify(latest.inFlight) === JSON.stringify(inFlight)) {
        await this.markRecovery(session.id, inFlight);
      } else {
        await clearApproved();
      }
      throw error;
    }
    if (isCancelled(input.signal)) {
      await this.markRecovery(session.id, inFlight);
      return cancellation();
    }
    const proposalEvidencePath = executionPath(inFlight, "proposal.json");
    const snapshotEvidencePath = executionPath(inFlight, "snapshot.json");
    let proposalEvidenceSha256: string;
    let snapshotEvidenceSha256: string;
    try {
      const evidenceStartedAt = this.dependencies.clock.now();
      await this.dependencies.store.writeEvidence(
        session.id,
        proposalEvidencePath,
        proposal
      );
      proposalEvidenceSha256 = sha256(canonicalEvidenceBytes(proposal));
      await this.dependencies.store.writeEvidence(
        session.id,
        snapshotEvidencePath,
        snapshot
      );
      snapshotEvidenceSha256 = sha256(canonicalEvidenceBytes(snapshot));
      timing.evidenceSetupMs = (
        this.dependencies.clock.now() - evidenceStartedAt
      );
    } catch (error) {
      await this.markRecovery(session.id, inFlight);
      throw error;
    }
    if (isCancelled(input.signal)) {
      await this.markRecovery(session.id, inFlight);
      return cancellation();
    }

    const logcat = new LogcatCollector(
      this.dependencies.adb,
      this.dependencies.clock
    );
    let logcatStarted = false;
    let finalStep: JourneyStep | undefined;
    let outcome: GenerationStepExecutionResult | undefined;
    let stableLayout: readonly LayoutElement[] | undefined;
    let postActionRuntime: LiveRuntime | undefined;
    let bridgeEscapedPackageName: string | undefined;
    const stepStartedAt = this.dependencies.clock.now();
    try {
      const logcatStartedAt = this.dependencies.clock.now();
      await logcat.start({
        deviceSerial: session.target.deviceSerial,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
      timing.logcatStartMs = (
        this.dependencies.clock.now() - logcatStartedAt
      );
      logcatStarted = true;
      throwIfCancelled(input.signal);
      const preActionStartedAt = this.dependencies.clock.now();
      const preAction = await this.observeLive(
        session,
        authoritativePid,
        proposal.activity.before,
        input.signal,
        fresh
      );
      timing.preActionObservationMs = (
        this.dependencies.clock.now() - preActionStartedAt
      );
      logcat.scopeToPids(preAction.pids);
      throwIfCancelled(input.signal);
      const provisional = executableStep(
        proposal,
        session.variables,
        proposal.activity.before
      );
      const actionExecutor = new ActionExecutor(
        this.dependencies.adb,
        session.target.deviceSerial
      );
      const idleWaiter = new IdleWaiter(
        this.dependencies.androidCli,
        this.dependencies.clock,
        session.target.deviceSerial,
        session.target.packageName
      );

      if (provisional.action === "scrollTo") {
        const actionStartedAt = this.dependencies.clock.now();
        const scroll = await new ScrollToExecutor({
          androidCli: this.dependencies.androidCli,
          actionExecutor,
          idleWaiter,
          deviceSerial: session.target.deviceSerial,
          idle: this.dependencies.idle,
          beforeSwipe: async (): Promise<readonly LayoutElement[]> => {
            const guarded = await this.observeLive(
              session,
              authoritativePid,
              proposal.activity.before,
              input.signal
            );
            return guarded.layout;
          },
          beforeMutation: async (): Promise<void> => {
            await this.assertForegroundIdentity(
              session,
              authoritativePid,
              proposal.activity.before,
              input.signal
            );
          },
          requireLiveContainerCapability: true
        }).execute(provisional, input.signal, preAction.layout);
        const scrollDurationMs = (
          this.dependencies.clock.now() - actionStartedAt
        );
        timing.idleWaitMs = scroll.idleDurationMs;
        timing.actionExecutionMs = Math.max(
          0,
          scrollDurationMs - timing.idleWaitMs
        );
        throwIfCancelled(input.signal);
        if (scroll.status === "cancelled") {
          outcome = {
            status: "cancelled",
            failure: { code: "RECOVERY_REQUIRED", message: "Step was cancelled" }
          };
        } else if (scroll.status === "failed") {
          fail(
            scroll.code,
            scroll.message,
            scroll.idle === undefined
              ? undefined
              : { idle: scroll.idle }
          );
        }
      } else if (provisional.action === "bridge") {
        throwIfCancelled(input.signal);
        await this.assertForegroundIdentity(
          session,
          authoritativePid,
          proposal.activity.before,
          input.signal
        );
        throwIfCancelled(input.signal);
        const triggerTarget = requireBridgeTrigger(
          preAction.layout,
          provisional
        );
        const triggerClick = JourneyStepSchema.parse({
          action: "click",
          locator: provisional.triggerLocator,
          activity: {
            before: provisional.activity.before,
            after: provisional.activity.before
          }
        });
        const actionStartedAt = this.dependencies.clock.now();
        const action = await actionExecutor.execute(
          triggerClick,
          triggerTarget,
          input.signal
        );
        timing.actionExecutionMs = (
          this.dependencies.clock.now() - actionStartedAt
        );
        if (isCancelled(input.signal)) {
          outcome = {
            status: "cancelled",
            failure: {
              code: "RECOVERY_REQUIRED",
              message: "Step was cancelled"
            }
          };
        } else if (action.status === "failed") {
          fail(action.code, action.message);
        }
        if (outcome === undefined) {
          throwIfCancelled(input.signal);
          const escapeStartedAt = this.dependencies.clock.now();
          const escapedPackageName = await this.detectBridgeEscape(
            session,
            input.signal,
            3000
          );
          timing.idleWaitMs = (
            this.dependencies.clock.now() - escapeStartedAt
          );
          if (isSystemScenario(provisional.scenario)) {
            if (
              !isKnownSystemPackage(
                provisional.scenario,
                escapedPackageName
              )
            ) {
              fail(
                "SCENARIO_PACKAGE_MISMATCH",
                `Escaped package "${escapedPackageName}" is not a known ${
                  provisional.scenario
                } package`
              );
            }
          }
          bridgeEscapedPackageName = escapedPackageName;
        }
        if (outcome === undefined) {
          throwIfCancelled(input.signal);
          const returnStartedAt = this.dependencies.clock.now();
          await this.waitForBridgeReturn(
            session,
            input.signal,
            provisional.returnTimeoutMs
          );
          timing.idleWaitMs += (
            this.dependencies.clock.now() - returnStartedAt
          );
          throwIfCancelled(input.signal);
          const idleStartedAt = this.dependencies.clock.now();
          const idle = await idleWaiter.waitUntilIdle(
            this.dependencies.idle,
            input.signal
          );
          timing.idleWaitMs += (
            this.dependencies.clock.now() - idleStartedAt
          );
          if (idle.status === "cancelled") {
            outcome = {
              status: "cancelled",
              failure: {
                code: "RECOVERY_REQUIRED",
                message: "Step was cancelled"
              }
            };
          } else if (idle.status === "timeout") {
            fail(
              idle.code,
              "Layout did not become stable after bridge return",
              idleTimeoutDetails(idle)
            );
          } else {
            stableLayout = idle.layout;
          }
        }
      } else {
        const target = requireTarget(preAction.layout, provisional);
        if (provisional.action === "inputText") {
          if (!hasExactlyOneEnabledFocusedElement(preAction.layout)) {
            fail(
              "ACTION_FAILED",
              "inputText requires exactly one enabled focused Layout element"
            );
          }
        }
        if (outcome === undefined) {
          throwIfCancelled(input.signal);
          await this.assertForegroundIdentity(
            session,
            authoritativePid,
            proposal.activity.before,
            input.signal
          );
          throwIfCancelled(input.signal);
          const actionStartedAt = this.dependencies.clock.now();
          const action = await actionExecutor.execute(
            provisional,
            target,
            input.signal
          );
          timing.actionExecutionMs = (
            this.dependencies.clock.now() - actionStartedAt
          );
          if (isCancelled(input.signal)) {
            outcome = {
              status: "cancelled",
              failure: {
                code: "RECOVERY_REQUIRED",
                message: "Step was cancelled"
              }
            };
          } else if (action.status === "failed") {
            fail(action.code, action.message);
          }
        }
        if (outcome === undefined) {
          const idleStartedAt = this.dependencies.clock.now();
          const idle = await idleWaiter.waitUntilIdle(
            this.dependencies.idle,
            input.signal
          );
          timing.idleWaitMs = (
            this.dependencies.clock.now() - idleStartedAt
          );
          if (idle.status === "cancelled") {
            outcome = {
              status: "cancelled",
              failure: {
                code: "RECOVERY_REQUIRED",
                message: "Step was cancelled"
              }
            };
          } else if (idle.status === "timeout") {
            fail(
              idle.code,
              "Layout did not become stable before timeout",
              idleTimeoutDetails(idle)
            );
          } else {
            stableLayout = idle.layout;
          }
          throwIfCancelled(input.signal);
        }
      }

      if (outcome === undefined) {
        throwIfCancelled(input.signal);
        const postActionStartedAt = this.dependencies.clock.now();
        const after = await this.observeLive(
          session,
          authoritativePid,
          undefined,
          input.signal,
          undefined,
          this.dependencies.idle.timeoutMs,
          stableLayout
        );
        timing.postActionObservationMs = (
          this.dependencies.clock.now() - postActionStartedAt
        );
        postActionRuntime = after;
        logcat.scopeToPids(after.pids);
        finalStep = executableStep(
          proposal,
          session.variables,
          after.activity,
          bridgeEscapedPackageName === undefined
            ? undefined
            : { escapedPackageName: bridgeEscapedPackageName }
        );
        if (finalStep.expect !== undefined) {
          const expectationStartedAt = this.dependencies.clock.now();
          let expectationRuntime: LiveRuntime | undefined;
          const expectation = await new ExpectationEvaluator(
            this.dependencies.adb,
            this.dependencies.androidCli,
            logcat,
            this.dependencies.clock
          ).evaluate(finalStep.expect, {
            packageName: session.target.packageName,
            deviceSerial: session.target.deviceSerial,
            stepStartedAt
          }, input.signal, {
            activity: async (
              observation: ExpectationObservationInput
            ): Promise<
              | { status: "observed"; activity: string }
              | { status: "failed"; message: string }
            > => {
              try {
                const activity = await this.assertForegroundIdentity(
                  session,
                  authoritativePid,
                  undefined,
                  observation.signal,
                  observation.timeoutMs
                );
                return { status: "observed", activity };
              } catch (error) {
                if (error instanceof StepCancelledError) throw error;
                return {
                  status: "failed",
                  message: error instanceof Error
                    ? error.message
                    : "Generated Expect Activity observation failed"
                };
              }
            },
            layout: async (
              observation: ExpectationObservationInput
            ): Promise<
              | { status: "observed"; layout: readonly LayoutElement[] }
              | { status: "failed"; message: string }
            > => {
              try {
                const guarded = await this.observeLive(
                  session,
                  authoritativePid,
                  after.activity,
                  observation.signal,
                  undefined,
                  observation.timeoutMs
                );
                expectationRuntime = guarded;
                return { status: "observed", layout: guarded.layout };
              } catch (error) {
                if (error instanceof StepCancelledError) throw error;
                return {
                  status: "failed",
                  message: error instanceof Error
                    ? error.message
                    : "Generated Expect Layout observation failed"
                };
              }
            }
          });
          if (expectation.status === "cancelled") {
            outcome = {
              status: "cancelled",
              failure: {
                code: "RECOVERY_REQUIRED",
                message: "Expectation evaluation was cancelled"
              }
            };
          } else if (expectation.status === "failed") {
            fail(expectation.code, expectation.message);
          } else {
            throwIfCancelled(input.signal);
            postActionRuntime = finalStep.expect.type === "element"
              && expectationRuntime !== undefined
              ? expectationRuntime
              : await this.observeLive(
                  session,
                  authoritativePid,
                  finalStep.expect.type === "activity"
                    ? finalStep.expect.value
                    : after.activity,
                  input.signal
                );
            throwIfCancelled(input.signal);
          }
          timing.expectationMs = (
            this.dependencies.clock.now() - expectationStartedAt
          );
        }
      }
    } catch (error) {
      outcome = error instanceof StepCancelledError
        ? cancellation()
        : { status: "failed", failure: asFailure(error) };
    }

    let stopFailure: GenerationStepFailure | undefined;
    if (logcatStarted) {
      const logcatStopStartedAt = this.dependencies.clock.now();
      try {
        const stopped = await logcat.stop();
        if (isCancelled(input.signal)) {
          outcome = cancellation();
        }
        if (logcatStopFailed(stopped)) {
          stopFailure = {
            code: "COLLECTION_FAILED",
            message: stopped.stderr.trim()
              || stopped.spawnError
              || "Logcat collector failed to stop"
          };
        }
      } catch (error) {
        stopFailure = {
          code: "COLLECTION_FAILED",
          message: error instanceof Error
            ? error.message
            : "Logcat collector failed to stop"
        };
      }
      timing.logcatStopMs = (
        this.dependencies.clock.now() - logcatStopStartedAt
      );
    }
    outcome ??= stopFailure === undefined
      ? { status: "succeeded", step: finalStep as JourneyStep }
      : { status: "failed", failure: stopFailure };
    timing.totalMs = this.dependencies.clock.now() - executionStartedAt;
    outcome = { ...outcome, timing };

    const log = logcatStarted
      ? logcat.lines().map((line) => line.raw).join("\n")
      : "";
    try {
      await this.dependencies.store.writeTextEvidence(
        session.id,
        executionPath(inFlight, "logcat.txt"),
        log.length === 0 ? "" : `${log}\n`
      );
    } catch (error) {
      await this.markRecovery(session.id, inFlight);
      throw error;
    }
    if (isCancelled(input.signal)) {
      await this.markRecovery(session.id, inFlight);
      return cancellation();
    }
    try {
      await this.dependencies.store.writeEvidence(
        session.id,
        executionPath(inFlight, "result.json"),
        {
          version: 1,
          stepIndex: inFlight.stepIndex,
          proposalHash: inFlight.proposalHash,
          snapshotHash: inFlight.snapshotHash,
          attemptId: inFlight.attemptId,
          source,
          proposalEvidence: {
            path: proposalEvidencePath,
            sha256: proposalEvidenceSha256
          },
          snapshotEvidence: {
            path: snapshotEvidencePath,
            sha256: snapshotEvidenceSha256
          },
          ...(inFlight.confirmation === undefined
            ? {}
            : { confirmation: inFlight.confirmation }),
          outcome,
          ...(stopFailure === undefined
            ? {}
            : { logcatStopFailure: stopFailure })
        }
      );
    } catch (error) {
      await this.markRecovery(session.id, inFlight);
      throw error;
    }
    if (isCancelled(input.signal)) {
      await this.markRecovery(session.id, inFlight);
      return cancellation();
    }

    if (outcome.status === "succeeded") {
      const next = GenerationSessionSchema.parse({
        ...begun,
        revision: begun.revision + 1,
        inFlight: null,
        candidateSteps: [...begun.candidateSteps, outcome.step],
        candidateSources: [...begun.candidateSources, source]
      });
      if (isCancelled(input.signal)) {
        await this.markRecovery(session.id, inFlight);
        return cancellation();
      }
      try {
        await this.dependencies.store.completeStep(
          session.id,
          begun.revision,
          inFlight,
          next
        );
      } catch (error) {
        let latest: GenerationSession;
        try {
          latest = GenerationSessionSchema.parse(
            await this.dependencies.store.read(session.id)
          );
        } catch {
          throw new GenerationOperationError(
            "RECOVERY_REQUIRED",
            "Unable to reconcile step completion state"
          );
        }
        if (sameSession(latest, next)) {
          return outcome;
        }
        if (
          latest.state === "active"
          && JSON.stringify(latest.inFlight) === JSON.stringify(inFlight)
        ) {
          await this.markRecovery(session.id, inFlight);
          throw error;
        }
        throw new GenerationOperationError(
          "RECOVERY_REQUIRED",
          "Step completion state is ambiguous and requires recovery"
        );
      }
      if (
        this.dependencies.observeNext === undefined
        || postActionRuntime === undefined
      ) {
        return outcome;
      }
      const nextObservationStartedAt = this.dependencies.clock.now();
      try {
        const nextObservation = await this.dependencies.observeNext({
          generationId: session.id,
          runtime: {
            foregroundPackageName: postActionRuntime.foregroundPackageName,
            activity: postActionRuntime.activity,
            pid: postActionRuntime.pid,
            layout: postActionRuntime.layout,
            windowHierarchy: postActionRuntime.windowHierarchy
          },
          ...(input.signal === undefined ? {} : { signal: input.signal })
        });
        return {
          ...outcome,
          timing: {
            ...timing,
            nextObservationMs: (
              this.dependencies.clock.now() - nextObservationStartedAt
            )
          },
          nextObservation
        };
      } catch (error) {
        return {
          ...outcome,
          timing: {
            ...timing,
            nextObservationMs: (
              this.dependencies.clock.now() - nextObservationStartedAt
            )
          },
          nextObservationFailure: asFailure(error)
        };
      }
    }

    await this.markRecovery(session.id, inFlight);
    return outcome;
  };

  private async observeLive(
    session: GenerationSession,
    expectedPid: number,
    expectedActivity: string | undefined,
    signal?: AbortSignal,
    authoritativeSnapshot?: RuntimeSnapshot,
    timeoutMs = this.dependencies.idle.timeoutMs,
    stableLayout?: readonly LayoutElement[]
  ): Promise<LiveRuntime> {
    const deadline = this.dependencies.clock.now() + timeoutMs;
    const identity = (): {
      packageName: string;
      deviceSerial: string;
      signal?: AbortSignal;
      timeoutMs: number;
    } => ({
      packageName: session.target.packageName,
      deviceSerial: session.target.deviceSerial,
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: Math.max(1, deadline - this.dependencies.clock.now())
    });
    const foreground = await this.dependencies.adb.foregroundComponent(
      identity()
    );
    throwIfCancelled(signal);
    if (foreground.packageName !== session.target.packageName) {
      fail("PACKAGE_ESCAPE", "Foreground package escaped generation target");
    }
    const processes = await this.dependencies.adb.appProcesses(identity());
    const pid = primaryAppPid(processes, session.target.packageName);
    throwIfCancelled(signal);
    if (pid === null || pid !== expectedPid) {
      fail("APP_CRASHED", "Generation process identity changed");
    }
    if (
      expectedActivity !== undefined
      && foreground.activity !== expectedActivity
    ) {
      fail("SNAPSHOT_STALE", "Generation Activity changed unexpectedly");
    }
    const [layout, topology] = await Promise.all([
      stableLayout === undefined
        ? this.dependencies.androidCli.layout({
            deviceSerial: session.target.deviceSerial,
            ...(signal === undefined ? {} : { signal }),
            timeoutMs: Math.max(1, deadline - this.dependencies.clock.now())
          })
        : Promise.resolve(stableLayout),
      this.dependencies.adb.windowTopology(identity())
    ]);
    const windowHierarchy = assessWindowHierarchy(topology, layout);
    throwIfCancelled(signal);
    const confirmedForeground = await this.dependencies.adb
      .foregroundComponent(identity());
    throwIfCancelled(signal);
    if (confirmedForeground.packageName !== session.target.packageName) {
      fail("PACKAGE_ESCAPE", "Foreground package escaped generation target");
    }
    const confirmedPid = primaryAppPid(
      await this.dependencies.adb.appProcesses(identity()),
      session.target.packageName
    );
    throwIfCancelled(signal);
    if (confirmedPid === null || confirmedPid !== expectedPid) {
      fail("APP_CRASHED", "Generation process identity changed");
    }
    if (
      confirmedForeground.activity
        !== (expectedActivity ?? foreground.activity)
    ) {
      fail("SNAPSHOT_STALE", "Generation Activity changed unexpectedly");
    }
    if (authoritativeSnapshot !== undefined) {
      const liveHash = hashRuntimeSnapshot({
        ...authoritativeSnapshot,
        foregroundPackageName: foreground.packageName,
        activity: foreground.activity,
        pid,
        layout,
        ...(authoritativeSnapshot.windowHierarchy === undefined
          ? {}
          : { windowHierarchy })
      });
      const authoritativeHash = hashRuntimeSnapshot(authoritativeSnapshot);
      if (liveHash !== authoritativeHash) {
        fail(
          "SNAPSHOT_STALE",
          `Generation Layout changed before action (${authoritativeHash} -> ${
            liveHash
          })`
        );
      }
    }
    return {
      foregroundPackageName: foreground.packageName,
      activity: foreground.activity,
      pid,
      pids: appProcessPids(processes),
      layout,
      windowHierarchy
    };
  }

  private async assertForegroundIdentity(
    session: GenerationSession,
    expectedPid: number,
    expectedActivity: string | undefined,
    signal?: AbortSignal,
    timeoutMs = this.dependencies.idle.timeoutMs
  ): Promise<string> {
    const deadline = this.dependencies.clock.now() + timeoutMs;
    const identity = (): {
      packageName: string;
      deviceSerial: string;
      signal?: AbortSignal;
      timeoutMs: number;
    } => ({
      packageName: session.target.packageName,
      deviceSerial: session.target.deviceSerial,
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: Math.max(1, deadline - this.dependencies.clock.now())
    });
    const foreground = await this.dependencies.adb.foregroundComponent(
      identity()
    );
    throwIfCancelled(signal);
    if (foreground.packageName !== session.target.packageName) {
      fail("PACKAGE_ESCAPE", "Foreground package escaped generation target");
    }
    if (
      expectedActivity !== undefined
      && foreground.activity !== expectedActivity
    ) {
      fail("SNAPSHOT_STALE", "Generation Activity changed before mutation");
    }
    const pid = primaryAppPid(
      await this.dependencies.adb.appProcesses(identity()),
      session.target.packageName
    );
    throwIfCancelled(signal);
    if (pid === null || pid !== expectedPid) {
      fail("APP_CRASHED", "Generation process identity changed");
    }
    return foreground.activity;
  }

  private async markRecovery(
    generationId: string,
    inFlight: GenerationInFlight
  ): Promise<void> {
    const latest = GenerationSessionSchema.parse(
      await this.dependencies.store.read(generationId)
    );
    if (
      latest.state === "recoveryRequired"
      && JSON.stringify(latest.inFlight) === JSON.stringify(inFlight)
    ) {
      return;
    }
    if (
      latest.state !== "active"
      || JSON.stringify(latest.inFlight) !== JSON.stringify(inFlight)
    ) {
      throw new GenerationOperationError(
        "RECOVERY_REQUIRED",
        "Step execution state changed before recovery could be persisted"
      );
    }
    const recovery = GenerationSessionSchema.parse({
      ...latest,
      revision: latest.revision + 1,
      state: "recoveryRequired",
      inFlight
    });
    await this.dependencies.store.update(
      generationId,
      latest.revision,
      recovery
    );
  }

  private async detectBridgeEscape(
    session: GenerationSession,
    signal: AbortSignal | undefined,
    timeoutMs: number
  ): Promise<string> {
    const deadline = this.dependencies.clock.now() + timeoutMs;
    while (this.dependencies.clock.now() < deadline) {
      throwIfCancelled(signal);
      const foreground = await this.dependencies.adb.foregroundComponent({
        packageName: session.target.packageName,
        deviceSerial: session.target.deviceSerial,
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: 5000
      });
      if (foreground.packageName !== session.target.packageName) {
        return foreground.packageName;
      }
      await this.dependencies.clock.sleep(
        Math.min(500, Math.max(0, deadline - this.dependencies.clock.now())),
        signal
      );
    }
    fail("BRIDGE_NO_ESCAPE", "Trigger did not cause a package escape");
  }

  private async waitForBridgeReturn(
    session: GenerationSession,
    signal: AbortSignal | undefined,
    timeoutMs: number
  ): Promise<void> {
    const deadline = this.dependencies.clock.now() + timeoutMs;
    while (this.dependencies.clock.now() < deadline) {
      throwIfCancelled(signal);
      const foreground = await this.dependencies.adb.foregroundComponent({
        packageName: session.target.packageName,
        deviceSerial: session.target.deviceSerial,
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: 5000
      });
      if (foreground.packageName === session.target.packageName) {
        return;
      }
      await this.dependencies.clock.sleep(
        Math.min(500, Math.max(0, deadline - this.dependencies.clock.now())),
        signal
      );
    }
    fail(
      "BRIDGE_NOT_RETURNED",
      "Foreground did not return to target package within the timeout"
    );
  }
}
