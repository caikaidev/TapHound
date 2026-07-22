import { z } from "zod";

import {
  GenerationSessionSchema,
  GenerationInFlightSchema,
  expandProposedStepVariables,
  type GenerationInFlight,
  type GenerationSession,
  type PendingConfirmation
} from "../../domain/generation.js";
import { JourneyStepSchema, type JourneyStep } from "../../domain/journey.js";
import type { LayoutElement } from "../../domain/layout.js";
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
import { ExpectationEvaluator } from "../assertion/expectation-evaluator.js";
import { LogcatCollector } from "../collector/logcat-collector.js";
import { ActionExecutor, type ActionTarget } from "../interaction/action-executor.js";
import { ScrollToExecutor } from "../interaction/scroll-to-executor.js";
import { resolveLocator } from "../locator/locator-resolver.js";
import { IdleWaiter, type IdleConfig } from "../wait/idle-waiter.js";
import {
  summarizeProposedStep
} from "./generation-confirmation-service.js";
import { GenerationOperationError } from "./generation-starter.js";
import type { SnapshotReobservationGuard } from "./runtime-observer.js";
import { RiskEvaluator } from "./risk-evaluator.js";

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
}

export type GenerationStepExecutionResult =
  | { status: "succeeded"; step: JourneyStep }
  | { status: "failed"; failure: GenerationStepFailure }
  | { status: "cancelled"; failure: GenerationStepFailure };

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
}

interface LiveRuntime {
  foregroundPackageName: string;
  activity: string;
  pid: number;
  layout: readonly LayoutElement[];
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

function flatten(elements: readonly LayoutElement[]): LayoutElement[] {
  return elements.flatMap((element) => [
    element,
    ...flatten(element.children)
  ]);
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
      message: error instanceof Error ? error.message : error.code
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "Unknown step failure"
  };
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
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
  now: Date
): PendingConfirmation {
  const challenge = session.pendingConfirmation;
  if (
    challenge === null
    || challenge.status !== "approved"
    || challenge.stepIndex !== session.candidateSteps.length
    || challenge.proposalHash !== hashProposedStep(proposal)
    || challenge.snapshotHash !== hashRuntimeSnapshot(snapshot)
    || challenge.snapshotHash !== proposal.binding.snapshotHash
    || challenge.actionSummary !== summarizeProposedStep(proposal)
    || now.getTime() >= new Date(challenge.expiresAt).getTime()
  ) {
    throw new GenerationOperationError(
      "RISK_CONFIRMATION_REQUIRED",
      "An exact non-expired approved confirmation is required"
    );
  }
  return challenge;
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
  after: string
): JourneyStep {
  const expanded = expandProposedStepVariables(proposal, variables);
  const action = Object.fromEntries(
    Object.entries(expanded).filter(
      ([key]) => key !== "binding" && key !== "activity"
    )
  );
  return JourneyStepSchema.parse({
    ...action,
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
  const resolution = resolveLocator(layout, step.locator);
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

export class GenerationStepExecutor {
  private readonly riskEvaluator = new RiskEvaluator();

  public constructor(
    private readonly dependencies: GenerationStepExecutorDependencies
  ) {}

  public readonly execute = async (
    input: GenerationStepExecutionInput
  ): Promise<GenerationStepExecutionResult> => {
    const proposal = ProposedStepSchema.parse(input.proposal);
    const snapshot = RuntimeSnapshotSchema.parse(input.snapshot);
    const source = z.enum(["planner", "manualOverride"]).parse(input.source);
    const session = GenerationSessionSchema.parse(
      await this.dependencies.store.read(input.generationId)
    );
    if (isCancelled(input.signal)) {
      return cancellation();
    }
    assertBaseAuthorization(session, proposal, snapshot);
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
    let approved: PendingConfirmation | undefined;
    if (risk.effectiveRisk === "confirmationRequired") {
      approved = exactApprovedChallenge(
        session,
        proposal,
        snapshot,
        this.dependencies.now()
      );
    } else if (
      session.revision !== proposal.binding.baseRevision
      || session.pendingConfirmation !== null
    ) {
      throw new GenerationOperationError(
        "SNAPSHOT_STALE",
        "Safe proposal revision is no longer current"
      );
    }

    const fresh = await this.dependencies.freshnessGuard.assertFresh(
      proposal.binding,
      input.signal,
      approved
    );
    if (isCancelled(input.signal)) {
      return cancellation();
    }
    if (fresh.foregroundPackageName !== session.target.packageName) {
      throw new GenerationOperationError(
        "PACKAGE_ESCAPE",
        "Fresh foreground package escaped the generation target"
      );
    }
    if (fresh.pid === null) {
      throw new GenerationOperationError(
        "APP_CRASHED",
        "Fresh generation process is not running"
      );
    }
    if (fresh.activity !== proposal.activity.before) {
      throw new GenerationOperationError(
        "SNAPSHOT_STALE",
        "Fresh Activity does not match the accepted proposal"
      );
    }
    const authoritativePid = fresh.pid;

    const inFlight = GenerationInFlightSchema.parse({
      stepIndex: session.candidateSteps.length,
      snapshotHash: proposal.binding.snapshotHash,
      proposalHash: hashProposedStep(proposal),
      attemptId: this.dependencies.generateAttemptId()
    });
    if (isCancelled(input.signal)) {
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
      }
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
    const stepStartedAt = this.dependencies.clock.now();
    try {
      await logcat.start({
        deviceSerial: session.target.deviceSerial,
        pid: authoritativePid,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
      logcatStarted = true;
      throwIfCancelled(input.signal);
      const preAction = await this.observeLive(
        session,
        authoritativePid,
        proposal.activity.before,
        input.signal,
        fresh
      );
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
        session.target.deviceSerial
      );

      if (provisional.action === "scrollTo") {
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
          }
        }).execute(provisional, input.signal, preAction.layout);
        throwIfCancelled(input.signal);
        if (scroll.status === "cancelled") {
          outcome = {
            status: "cancelled",
            failure: { code: "RECOVERY_REQUIRED", message: "Step was cancelled" }
          };
        } else if (scroll.status === "failed") {
          fail(scroll.code, scroll.message);
        }
      } else {
        const target = requireTarget(preAction.layout, provisional);
        if (provisional.action === "inputText") {
          const focused = flatten(preAction.layout).filter(
            (element) => element.enabled && element.focused === true
          );
          if (focused.length !== 1) {
            fail(
              "ACTION_FAILED",
              "inputText requires exactly one enabled focused Layout element"
            );
          }
        }
        if (outcome === undefined) {
          throwIfCancelled(input.signal);
          const action = await actionExecutor.execute(
            provisional,
            target,
            input.signal
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
          const idle = await idleWaiter.waitUntilIdle(
            this.dependencies.idle,
            input.signal
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
            fail(idle.code, "Layout did not become stable before timeout");
          }
          throwIfCancelled(input.signal);
        }
      }

      if (outcome === undefined) {
        throwIfCancelled(input.signal);
        const after = await this.observeLive(
          session,
          authoritativePid,
          undefined,
          input.signal
        );
        finalStep = executableStep(
          proposal,
          session.variables,
          after.activity
        );
        if (finalStep.expect !== undefined) {
          const expectation = await new ExpectationEvaluator(
            this.dependencies.adb,
            this.dependencies.androidCli,
            logcat,
            this.dependencies.clock
          ).evaluate(finalStep.expect, {
            packageName: session.target.packageName,
            deviceSerial: session.target.deviceSerial,
            stepStartedAt
          }, input.signal);
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
          }
          throwIfCancelled(input.signal);
          await this.observeLive(
            session,
            authoritativePid,
            after.activity,
            input.signal
          );
          throwIfCancelled(input.signal);
        }
      }
    } catch (error) {
      outcome = error instanceof StepCancelledError
        ? cancellation()
        : { status: "failed", failure: asFailure(error) };
    }

    let stopFailure: GenerationStepFailure | undefined;
    if (logcatStarted) {
      try {
        const stopped = await logcat.stop();
        if (isCancelled(input.signal)) {
          outcome = cancellation();
        }
        if (
          stopped.exitCode !== 0
          || stopped.timedOut
          || stopped.cancelled
          || stopped.spawnError !== undefined
        ) {
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
    }
    outcome ??= stopFailure === undefined
      ? { status: "succeeded", step: finalStep as JourneyStep }
      : { status: "failed", failure: stopFailure };

    const log = logcatStarted
      ? logcat.lines().map((line) => line.raw).join("\n")
      : "";
    try {
      await this.dependencies.store.writeTextEvidence(
        session.id,
        executionPath(inFlight, "logcat.txt"),
        log.length === 0 ? "" : `${log}\n`
      );
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

    if (outcome.status === "succeeded") {
      const next = GenerationSessionSchema.parse({
        ...begun,
        revision: begun.revision + 1,
        inFlight: null,
        candidateSteps: [...begun.candidateSteps, outcome.step],
        candidateSources: [...begun.candidateSources, source]
      });
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
      return outcome;
    }

    await this.markRecovery(session.id, inFlight);
    return outcome;
  };

  private async observeLive(
    session: GenerationSession,
    expectedPid: number,
    expectedActivity: string | undefined,
    signal?: AbortSignal,
    authoritativeSnapshot?: RuntimeSnapshot
  ): Promise<LiveRuntime> {
    const identity = {
      packageName: session.target.packageName,
      deviceSerial: session.target.deviceSerial,
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: this.dependencies.idle.timeoutMs
    };
    const foreground = await this.dependencies.adb.foregroundComponent(
      identity
    );
    throwIfCancelled(signal);
    if (foreground.packageName !== session.target.packageName) {
      fail("PACKAGE_ESCAPE", "Foreground package escaped generation target");
    }
    const pid = await this.dependencies.adb.pid(identity);
    throwIfCancelled(signal);
    if (pid === null || pid !== expectedPid) {
      fail("APP_CRASHED", "Generation process identity changed");
    }
    const layout = await this.dependencies.androidCli.layout({
      deviceSerial: session.target.deviceSerial,
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: this.dependencies.idle.timeoutMs
    });
    throwIfCancelled(signal);
    if (
      expectedActivity !== undefined
      && foreground.activity !== expectedActivity
    ) {
      fail("SNAPSHOT_STALE", "Generation Activity changed unexpectedly");
    }
    if (authoritativeSnapshot !== undefined) {
      const liveHash = hashRuntimeSnapshot({
        ...authoritativeSnapshot,
        foregroundPackageName: foreground.packageName,
        activity: foreground.activity,
        pid,
        layout
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
      layout
    };
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
}
