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
import type { DisplayViewport } from "../../domain/geometry.js";
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
import type { Clock } from "../../ports/clock.js";
import type { UiStabilityProbe } from "../../ports/ui-stability.js";
import type { GenerationSessionStore } from "../../ports/generation-session-store.js";
import type {
  CaptureUiSnapshotOptions,
  UiSnapshot,
  UiSnapshotProvider,
  UiSnapshotProviderFactory
} from "../../ports/ui-snapshot.js";
import {
  isKnownSystemPackage,
  isSystemScenario
} from "../../domain/system-app-profiles.js";
import type { ExternalStep } from "../../domain/journey.js";
import type { ExternalFlowResolution } from "../journey/external-flow-resolver.js";
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
import { closeUiSnapshotProvider } from "../ui/ui-snapshot-lifecycle.js";

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
  freshnessGuard?: Pick<SnapshotReobservationGuard, "assertFresh"> | undefined;
  createFreshnessGuard?: ((
    uiSnapshotProvider: UiSnapshotProvider
  ) => Pick<SnapshotReobservationGuard, "assertFresh">) | undefined;
  adb: AdbPort;
  uiStability: UiStabilityProbe;
  uiSnapshotProvider?: UiSnapshotProvider | undefined;
  uiSnapshots?: UiSnapshotProviderFactory | undefined;
  uiCacheEnabled?: boolean | undefined;
  clock: Clock;
  idle: IdleConfig;
  now: () => Date;
  generateAttemptId: () => string;
  projectRoot: string;
  externalFlowResolver?: {
    resolve: (input: {
      projectRoot: string;
      name: string;
    }) => Promise<ExternalFlowResolution>;
  } | undefined;
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
  viewport: DisplayViewport;
  uiSnapshot: Pick<
    UiSnapshot,
    "observationId" | "capturedAt" | "durationMs" | "backend" | "viewport"
  >;
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
      ([key]) => key !== "binding" && key !== "activity" && key !== "flow"
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
  step: JourneyStep,
  viewport: DisplayViewport
): ActionTarget | undefined {
  if (
    step.action !== "click"
    && step.action !== "longClick"
    && step.action !== "swipe"
  ) {
    return undefined;
  }
  const resolution = resolveLocator(layout, step.locator, {
    viewport,
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
  step: Extract<JourneyStep, { action: "bridge" }>,
  viewport: DisplayViewport
): ActionTarget {
  const resolution = resolveLocator(layout, step.triggerLocator, {
    requiredCapability: "clickable",
    viewport
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

function externalStepToJourneyStep(step: ExternalStep): JourneyStep {
  const { expectedActivity, ...rest } = step;
  return JourneyStepSchema.parse({
    ...rest,
    activity: {
      before: expectedActivity,
      after: expectedActivity
    }
  });
}

function requireExternalTarget(
  layout: readonly LayoutElement[],
  step: ExternalStep,
  viewport: DisplayViewport
): ActionTarget | undefined {
  if (
    step.action !== "click"
    && step.action !== "longClick"
    && step.action !== "swipe"
  ) {
    return undefined;
  }
  const resolution = resolveLocator(layout, step.locator, {
    viewport,
    ...(step.action === "click" ? { requiredCapability: "clickable" } : {}),
    ...(step.action === "longClick"
      ? { requiredCapability: "longClickable" }
      : {})
  });
  if (resolution.status !== "found") {
    fail(resolution.code, resolution.message);
  }
  if (step.action === "click" && resolution.element.clickable !== true) {
    fail("ACTION_FAILED", "external click target is not clickable");
  }
  if (
    step.action === "longClick"
    && resolution.element.longClickable !== true
  ) {
    fail("ACTION_FAILED", "external longClick target is not longClickable");
  }
  if (
    step.action === "swipe"
    && (
      resolution.element.scrollable !== true
      || resolution.element.bounds === undefined
    )
  ) {
    fail("ACTION_FAILED", "external swipe target lacks scrollable bounds");
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
  private currentViewport: DisplayViewport | undefined;
  private currentUiSnapshot: LiveRuntime["uiSnapshot"] | undefined;

  public constructor(
    private readonly dependencies: GenerationStepExecutorDependencies
  ) {}

  private boundUiSnapshotProvider(): UiSnapshotProvider {
    const uiSnapshotProvider = this.dependencies.uiSnapshotProvider;
    if (uiSnapshotProvider === undefined) {
      throw new Error("Generation UI snapshot provider is not bound");
    }
    return uiSnapshotProvider;
  }

  private requireCurrentViewport(): DisplayViewport {
    if (this.currentViewport === undefined) {
      throw new Error("Generation UI snapshot viewport is unavailable");
    }
    return this.currentViewport;
  }

  private requireCurrentUiSnapshot(): LiveRuntime["uiSnapshot"] {
    if (this.currentUiSnapshot === undefined) {
      throw new Error("Generation UI snapshot metadata is unavailable");
    }
    return this.currentUiSnapshot;
  }

  private async captureLayout(
    reason: CaptureUiSnapshotOptions["reason"],
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<readonly LayoutElement[]> {
    const uiSnapshotProvider = this.boundUiSnapshotProvider();
    const snapshot = await uiSnapshotProvider.capture({
      reason,
      freshness: "sameMutationEpoch",
      timeoutMs,
      ...(signal === undefined ? {} : { signal })
    });
    this.currentViewport = snapshot.viewport;
    this.currentUiSnapshot = {
      observationId: snapshot.observationId,
      capturedAt: snapshot.capturedAt,
      durationMs: snapshot.durationMs,
      backend: snapshot.backend,
      viewport: snapshot.viewport
    };
    return snapshot.roots;
  }

  public readonly execute = async (
    input: GenerationStepExecutionInput
  ): Promise<GenerationStepExecutionResult> => {
    if (this.dependencies.uiSnapshotProvider === undefined) {
      if (
        this.dependencies.uiSnapshots === undefined
        || this.dependencies.createFreshnessGuard === undefined
      ) {
        throw new Error("Generation UI snapshot provider factory is unavailable");
      }
      const session = GenerationSessionSchema.parse(
        await this.dependencies.store.read(input.generationId)
      );
      const uiSnapshotProvider = await this.dependencies.uiSnapshots.open({
        deviceSerial: session.target.deviceSerial,
        timeoutMs: this.dependencies.idle.timeoutMs,
        ...(session.bindings.uiBackend === undefined
          ? {}
          : { backend: session.bindings.uiBackend.id }),
        ...(this.dependencies.uiCacheEnabled === undefined
          ? {}
          : { cacheEnabled: this.dependencies.uiCacheEnabled }),
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
      try {
        return await new GenerationStepExecutor({
          ...this.dependencies,
          freshnessGuard: this.dependencies.createFreshnessGuard(
            uiSnapshotProvider
          ),
          uiSnapshotProvider
        }).execute(input);
      } finally {
        await closeUiSnapshotProvider(uiSnapshotProvider);
      }
    }
    const freshnessGuard = this.dependencies.freshnessGuard;
    if (freshnessGuard === undefined) {
      throw new Error("Generation freshness guard is unavailable");
    }
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
    if (
      session.bindings.uiBackend !== undefined
      && JSON.stringify(session.bindings.uiBackend)
        !== JSON.stringify(this.boundUiSnapshotProvider().descriptor)
    ) {
      throw new GenerationOperationError(
        "CONFIG_INVALID",
        "Generation UI backend does not match the authoritative session"
      );
    }
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
      fresh = await freshnessGuard.assertFresh(
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
    let bridgeExternalSteps: readonly ExternalStep[] | undefined;
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
      const proposedFlow = proposal.action === "bridge"
        ? proposal.flow
        : undefined;
      const provisional = executableStep(
        proposal,
        session.variables,
        proposal.activity.before
      );
      const actionExecutor = new ActionExecutor(
        this.dependencies.adb,
        session.target.deviceSerial,
        (): void => this.boundUiSnapshotProvider().invalidate?.("beforeAction")
      );
      const idleWaiter = new IdleWaiter(
        this.dependencies.uiStability,
        this.dependencies.clock,
        session.target.deviceSerial,
        session.target.packageName
      );

      if (provisional.action === "scrollTo") {
        const actionStartedAt = this.dependencies.clock.now();
        const scroll = await new ScrollToExecutor({
          uiSnapshotProvider: this.boundUiSnapshotProvider(),
          actionExecutor,
          idleWaiter,
          deviceSerial: session.target.deviceSerial,
          idle: this.dependencies.idle,
          viewport: (): DisplayViewport | undefined => this.currentViewport,
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
          provisional,
          preAction.viewport
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
            provisional.escapeTimeoutMs ?? 3000
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
        if (outcome === undefined && proposedFlow !== undefined) {
          throwIfCancelled(input.signal);
          const flowResult = await this.resolveAndExecuteExternalFlow(
            session,
            proposedFlow,
            bridgeEscapedPackageName as string,
            input.signal
          );
          bridgeExternalSteps = flowResult;
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
        const target = requireTarget(
          preAction.layout,
          provisional,
          preAction.viewport
        );
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
        const bridgeExtra: Record<string, unknown> = {};
        if (bridgeEscapedPackageName !== undefined) {
          bridgeExtra.escapedPackageName = bridgeEscapedPackageName;
        }
        if (bridgeExternalSteps !== undefined) {
          bridgeExtra.externalSteps = bridgeExternalSteps;
          bridgeExtra.replayMode = "auto" as const;
        }
        finalStep = executableStep(
          proposal,
          session.variables,
          after.activity,
          Object.keys(bridgeExtra).length === 0 ? undefined : bridgeExtra
        );
        if (finalStep.expect !== undefined) {
          const expectationStartedAt = this.dependencies.clock.now();
          let expectationRuntime: LiveRuntime | undefined;
          const expectation = await new ExpectationEvaluator(
            this.dependencies.adb,
            this.boundUiSnapshotProvider(),
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
            windowHierarchy: postActionRuntime.windowHierarchy,
            uiSnapshot: postActionRuntime.uiSnapshot
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
        ? this.captureLayout(
            "locate",
            Math.max(1, deadline - this.dependencies.clock.now()),
            signal
          )
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
      viewport: this.requireCurrentViewport(),
      uiSnapshot: this.requireCurrentUiSnapshot(),
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

  private async resolveAndExecuteExternalFlow(
    session: GenerationSession,
    flowName: string,
    escapedPackageName: string,
    signal: AbortSignal | undefined
  ): Promise<readonly ExternalStep[]> {
    if (this.dependencies.externalFlowResolver === undefined) {
      fail(
        "EXTERNAL_FLOW_NOT_FOUND",
        "External Flow resolver is unavailable in this runtime"
      );
    }
    const binding = session.externalFlows.find(
      (entry) => entry.name === flowName
    );
    if (binding === undefined) {
      fail(
        "EXTERNAL_FLOW_NOT_FOUND",
        `External Flow "${flowName}" is not bound to generation session ${
          session.id
        }`
      );
    }
    const resolution = await this.dependencies.externalFlowResolver.resolve({
      projectRoot: this.dependencies.projectRoot,
      name: flowName
    });
    if (resolution.flowSha256 !== binding.flowSha256) {
      fail(
        "EXTERNAL_FLOW_STALE",
        `External Flow "${flowName}" has changed since session start`
      );
    }
    if (resolution.flow.escapedPackageName !== binding.escapedPackageName) {
      fail(
        "EXTERNAL_PACKAGE_MISMATCH",
        `External Flow "${flowName}" escaped package does not match session binding`
      );
    }
    if (resolution.flow.escapedPackageName !== escapedPackageName) {
      fail(
        "EXTERNAL_PACKAGE_MISMATCH",
        `Escaped package "${escapedPackageName}" does not match Flow package "${
          resolution.flow.escapedPackageName
        }"`
      );
    }
    if (resolution.flow.expectedEscapeActivity !== undefined) {
      const foreground = await this.dependencies.adb.foregroundComponent({
        packageName: escapedPackageName,
        deviceSerial: session.target.deviceSerial,
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: 5000
      });
      if (foreground.activity !== resolution.flow.expectedEscapeActivity) {
        fail(
          "EXTERNAL_ACTIVITY_MISMATCH",
          `External escape Activity "${
            foreground.activity
          }" does not match expected "${
            resolution.flow.expectedEscapeActivity
          }"`
        );
      }
    }
    const actionExecutor = new ActionExecutor(
      this.dependencies.adb,
      session.target.deviceSerial,
      (): void => this.boundUiSnapshotProvider().invalidate?.("beforeAction")
    );
    for (const externalStep of resolution.flow.steps) {
      throwIfCancelled(signal);
      await this.executeExternalStep(
        session,
        externalStep,
        escapedPackageName,
        actionExecutor,
        signal
      );
    }
    return resolution.flow.steps;
  }

  private async executeExternalStep(
    session: GenerationSession,
    step: ExternalStep,
    escapedPackageName: string,
    actionExecutor: ActionExecutor,
    signal: AbortSignal | undefined
  ): Promise<void> {
    const identity = {
      packageName: escapedPackageName,
      deviceSerial: session.target.deviceSerial,
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: 5000
    };
    const foreground = await this.dependencies.adb.foregroundComponent(
      identity
    );
    throwIfCancelled(signal);
    if (foreground.packageName !== escapedPackageName) {
      fail(
        "EXTERNAL_PACKAGE_MISMATCH",
        "External app foreground package changed during step execution"
      );
    }
    if (foreground.activity !== step.expectedActivity) {
      fail(
        "EXTERNAL_ACTIVITY_MISMATCH",
        `External Activity mismatch: expected "${
          step.expectedActivity
        }", got "${foreground.activity}"`
      );
    }
    const layout = await this.captureLayout("locate", 5000, signal);
    throwIfCancelled(signal);

    if (step.action === "scrollTo") {
      const journeyStep = externalStepToJourneyStep(step) as Extract<
        JourneyStep,
        { action: "scrollTo" }
      >;
      const externalIdleWaiter = new IdleWaiter(
        this.dependencies.uiStability,
        this.dependencies.clock,
        session.target.deviceSerial,
        escapedPackageName
      );
      const scroll = await new ScrollToExecutor({
        uiSnapshotProvider: this.boundUiSnapshotProvider(),
        actionExecutor,
        idleWaiter: externalIdleWaiter,
        deviceSerial: session.target.deviceSerial,
        idle: this.dependencies.idle,
        viewport: (): DisplayViewport | undefined => this.currentViewport,
        beforeSwipe: async (): Promise<readonly LayoutElement[]> => {
          const guarded = await this.observeExternalLive(
            session,
            escapedPackageName,
            step.expectedActivity,
            signal
          );
          return guarded.layout;
        },
        beforeMutation: async (): Promise<void> => {
          await this.assertExternalForeground(
            session,
            escapedPackageName,
            step.expectedActivity,
            signal
          );
        },
        requireLiveContainerCapability: true
      }).execute(journeyStep, signal, layout);
      if (scroll.status === "cancelled") {
        throw new StepCancelledError("External scrollTo was cancelled");
      }
      if (scroll.status === "failed") {
        fail(
          scroll.code,
          scroll.message,
          scroll.idle === undefined ? undefined : { idle: scroll.idle }
        );
      }
    } else {
      const journeyStep = externalStepToJourneyStep(step);
      let target: ActionTarget | undefined;
      if (
        step.action === "click"
        || step.action === "longClick"
        || step.action === "swipe"
      ) {
        target = requireExternalTarget(
          layout,
          step,
          this.requireCurrentViewport()
        );
      }
      const action = await actionExecutor.execute(
        journeyStep,
        target,
        signal
      );
      if (action.status === "failed") {
        fail(action.code, action.message);
      }
    }

    const externalIdleWaiter = new IdleWaiter(
      this.dependencies.uiStability,
      this.dependencies.clock,
      session.target.deviceSerial,
      escapedPackageName
    );
    const idle = await externalIdleWaiter.waitUntilIdle(
      this.dependencies.idle,
      signal
    );
    throwIfCancelled(signal);
    if (idle.status === "cancelled") {
      throw new StepCancelledError("External step was cancelled");
    }
    if (idle.status === "timeout") {
      fail(
        idle.code,
        "External app layout did not become stable after step",
        idleTimeoutDetails(idle)
      );
    }

    if (step.expect !== undefined) {
      await this.evaluateExternalExpect(
        session,
        step,
        escapedPackageName,
        signal
      );
    }
  }

  private async observeExternalLive(
    session: GenerationSession,
    escapedPackageName: string,
    expectedActivity: string,
    signal: AbortSignal | undefined
  ): Promise<{ layout: readonly LayoutElement[] }> {
    const identity = {
      packageName: escapedPackageName,
      deviceSerial: session.target.deviceSerial,
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: 5000
    };
    const foreground = await this.dependencies.adb.foregroundComponent(
      identity
    );
    throwIfCancelled(signal);
    if (foreground.packageName !== escapedPackageName) {
      fail(
        "EXTERNAL_PACKAGE_MISMATCH",
        "External app foreground package changed during observation"
      );
    }
    if (foreground.activity !== expectedActivity) {
      fail(
        "EXTERNAL_ACTIVITY_MISMATCH",
        `External Activity mismatch: expected "${expectedActivity}", got "${
          foreground.activity
        }"`
      );
    }
    const layout = await this.captureLayout("locate", 5000, signal);
    return { layout };
  }

  private async assertExternalForeground(
    session: GenerationSession,
    escapedPackageName: string,
    expectedActivity: string,
    signal: AbortSignal | undefined
  ): Promise<void> {
    const identity = {
      packageName: escapedPackageName,
      deviceSerial: session.target.deviceSerial,
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: 5000
    };
    const foreground = await this.dependencies.adb.foregroundComponent(
      identity
    );
    throwIfCancelled(signal);
    if (foreground.packageName !== escapedPackageName) {
      fail(
        "EXTERNAL_PACKAGE_MISMATCH",
        "External app foreground package changed before mutation"
      );
    }
    if (foreground.activity !== expectedActivity) {
      fail(
        "EXTERNAL_ACTIVITY_MISMATCH",
        `External Activity changed before mutation: expected "${
          expectedActivity
        }", got "${foreground.activity}"`
      );
    }
  }

  private async evaluateExternalExpect(
    session: GenerationSession,
    step: ExternalStep,
    escapedPackageName: string,
    signal: AbortSignal | undefined
  ): Promise<void> {
    const expect = step.expect;
    if (expect === undefined) {
      return;
    }
    const identity = {
      packageName: escapedPackageName,
      deviceSerial: session.target.deviceSerial,
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: expect.timeoutMs
    };
    if (expect.type === "activity") {
      const expectedPackage = expect.packageName ?? escapedPackageName;
      const foreground = await this.dependencies.adb.foregroundComponent({
        ...identity,
        packageName: expectedPackage
      });
      throwIfCancelled(signal);
      if (foreground.activity !== expect.value) {
        fail(
          "EXTERNAL_STEP_FAILED",
          `External expect Activity mismatch: expected "${
            expect.value
          }", got "${foreground.activity}"`
        );
      }
    } else if (expect.type === "element") {
      const layout = await this.captureLayout(
        "expect",
        expect.timeoutMs,
        signal
      );
      throwIfCancelled(signal);
      const resolution = resolveLocator(layout, expect.locator, {
        requireEnabled: false
      });
      if (resolution.status !== "found") {
        fail(
          "EXTERNAL_STEP_FAILED",
          `External expect element not found: ${resolution.message}`
        );
      }
    } else {
      fail(
        "EXTERNAL_STEP_FAILED",
        "logcat expectations are not supported for external steps in v1"
      );
    }
  }
}
