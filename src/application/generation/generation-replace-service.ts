import { realpath } from "node:fs/promises";

import {
  GenerationSessionSchema,
  type GenerationSession
} from "../../domain/generation.js";
import type { TapHoundConfig } from "../../domain/config.js";
import { DEFAULT_DEVICE_ROLE, JourneySchema } from "../../domain/journey.js";
import type { GenerationSessionStore } from "../../ports/generation-session-store.js";
import type {
  RuntimeObservation,
  RuntimeObserver
} from "./runtime-observer.js";
import type {
  VerifyInput,
  VerifyRuntime
} from "../runtime/verify-runtime.js";
import type { GenerationAppPreparer } from "./generation-app-preparer.js";
import { GenerationOperationError } from "./generation-starter.js";

export interface GenerationReplaceInput {
  generationId: string;
  stepIndex: number;
  projectRoot: string;
  config: TapHoundConfig;
  toolVersions: Record<string, string>;
  manualReplay?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface GenerationReplaceResult {
  status: "replaced";
  stepIndex: number;
  remainingStepCount: number;
  truncatedStepCount: number;
  observation: RuntimeObservation;
}

export interface GenerationReplaceDependencies {
  store: Pick<GenerationSessionStore, "read" | "update">;
  observer: Pick<RuntimeObserver, "observe">;
  verifyRuntime: Pick<VerifyRuntime, "verify">;
  appPreparer: Pick<GenerationAppPreparer, "prepare">;
}

function assertReplaceable(session: GenerationSession): void {
  if (session.state === "recoveryRequired") {
    throw new GenerationOperationError(
      "RECOVERY_REQUIRED",
      "Generation session must be recovered before replacing steps"
    );
  }
  if (session.state !== "active") {
    throw new GenerationOperationError(
      "CONFIG_INVALID",
      `Generation steps can only be replaced on an active session (state: ${session.state})`
    );
  }
  if (session.inFlight !== null) {
    throw new GenerationOperationError(
      "RECOVERY_REQUIRED",
      "Generation steps cannot be replaced while a step is in flight"
    );
  }
  if (session.pendingConfirmation !== null) {
    throw new GenerationOperationError(
      "RISK_CONFIRMATION_REQUIRED",
      `Generation confirmation ${session.pendingConfirmation.challengeId} must be resolved before replacing steps`
    );
  }
  if (session.verification.status !== "notRun") {
    throw new GenerationOperationError(
      "CONFIG_INVALID",
      "Generation steps cannot be replaced once verification has started"
    );
  }
  if (session.publication.status !== "notRun") {
    throw new GenerationOperationError(
      "CONFIG_INVALID",
      "Generation steps cannot be replaced after publication"
    );
  }
  if (
    session.bindings.uiBackend === undefined
    && (
      session.bindings.snapshotHash !== null
      || session.candidateSteps.length !== 0
    )
  ) {
    throw new GenerationOperationError(
      "CONFIG_INVALID",
      "Legacy generation sessions with evidence cannot replace steps; start a new session"
    );
  }
}

function assertReplaceIndex(
  session: GenerationSession,
  stepIndex: number
): void {
  if (
    !Number.isInteger(stepIndex)
    || stepIndex < 0
    || stepIndex > session.candidateSteps.length
  ) {
    throw new GenerationOperationError(
      "CONFIG_INVALID",
      `Replace step index must be between 0 and the candidate step count (${String(
        session.candidateSteps.length
      )})`
    );
  }
  const flowStepCount = session.candidateSources.filter(
    (source) => source === "flow"
  ).length;
  if (stepIndex < flowStepCount) {
    throw new GenerationOperationError(
      "FLOW_INVALID",
      "Replace step index cannot target the bound Base Flow prefix; start a new session with a different Flow"
    );
  }
}

export class GenerationReplaceService {
  public constructor(
    private readonly dependencies: GenerationReplaceDependencies
  ) {}

  public readonly replace = async (
    input: GenerationReplaceInput
  ): Promise<GenerationReplaceResult> => {
    const session = GenerationSessionSchema.parse(
      await this.dependencies.store.read(input.generationId)
    );
    assertReplaceable(session);
    assertReplaceIndex(session, input.stepIndex);
    const replayConfig: TapHoundConfig = session.idlePolicy === undefined
      ? input.config
      : { ...input.config, idle: session.idlePolicy };
    const prefixSteps = session.candidateSteps.slice(0, input.stepIndex);

    if (prefixSteps.length === 0) {
      try {
        await this.dependencies.appPreparer.prepare({
          config: replayConfig,
          deviceSerial: session.target.deviceSerial,
          ...(input.signal === undefined ? {} : { signal: input.signal })
        });
      } catch (error) {
        throw new GenerationOperationError(
          "APP_LAUNCH_FAILED",
          error instanceof Error ? error.message : String(error)
        );
      }
    } else {
      const canonicalProjectRoot = await realpath(input.projectRoot);
      const journey = JourneySchema.parse({
        version: 2,
        name: `generation-${session.id}-prefix-${String(input.stepIndex)}`,
        devices: [{ role: DEFAULT_DEVICE_ROLE }],
        steps: prefixSteps
      });
      const result = await this.dependencies.verifyRuntime.verify({
        config: replayConfig,
        journey,
        projectRoot: canonicalProjectRoot,
        devices: [{
          role: DEFAULT_DEVICE_ROLE,
          deviceSerial: session.target.deviceSerial
        }],
        toolVersions: input.toolVersions,
        requireFocusedInput: true,
        generatedReplayPolicy: true,
        ...(input.manualReplay === undefined
          ? {}
          : { manualReplay: input.manualReplay }),
        ...(input.signal === undefined ? {} : { signal: input.signal })
      } satisfies VerifyInput);
      if (result.status !== "passed" || result.exitCode !== 0) {
        const failure = result.report.primaryFailure;
        throw new GenerationOperationError(
          "VERIFICATION_FAILED",
          `Prefix replay failed before step replacement${
            failure === undefined
              ? ""
              : ` (${
                failure.stepIndex === undefined
                  ? ""
                  : `step ${String(failure.stepIndex)}: `
              }${failure.code} - ${failure.message})`
          }; see ${result.reportPath}`
        );
      }
    }

    if (input.stepIndex < session.candidateSteps.length) {
      const truncated = GenerationSessionSchema.parse({
        ...session,
        revision: session.revision + 1,
        candidateSteps: prefixSteps,
        candidateSources: session.candidateSources.slice(0, input.stepIndex)
      });
      await this.dependencies.store.update(
        session.id,
        session.revision,
        truncated
      );
    }

    const observation = await this.dependencies.observer.observe({
      generationId: session.id,
      idle: input.config.idle,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });

    return {
      status: "replaced",
      stepIndex: input.stepIndex,
      remainingStepCount: prefixSteps.length,
      truncatedStepCount: session.candidateSteps.length - input.stepIndex,
      observation
    };
  };
}
