// Options, output, failure mapping, and configuration shared by the `generation` subcommands.

import { resolve } from "node:path";

import { Command } from "commander";
import { z } from "zod";
import {
  exitCodeForFailure,
  failureCodeFromUnknown
} from "../../../domain/failure.js";

import {
  GenerationFinalizationError
} from "../../../application/generation/generation-finalizer.js";
import {
  GenerationOperationError
} from "../../../application/generation/generation-starter.js";
import {
  ContextLoadError
} from "../../../application/context/context-loader.js";
import type { TapHoundConfig } from "../../../domain/config.js";
import type {
  GenerationStepTiming
} from "../../../application/generation/generation-step-executor.js";
import type {
  GenerationRecoveryStatus
} from "../../../application/generation/generation-recovery-service.js";
import { TapHoundConfigSchema } from "../../../domain/config.js";
import {
  verificationPhaseLabel
} from "../../../domain/generation.js";
import { ProposedStepSchema } from "../../../domain/proposed-step.js";
import { RuntimeSnapshotSchema } from "../../../domain/runtime-snapshot.js";
import {
  assertArtifactDirectory,
  CONFIG_PATH
} from "../../../domain/workspace.js";
import {
  GenerationSessionStoreError
} from "../../../ports/generation-session-store.js";
import {
  GenerationPromptCancelledError
} from "../../../ports/generation-prompt.js";
import type { CliDependencies } from "../../dependencies.js";
import {
  contextLoadHint,
  errorMessage,
  writeJson,
  writeLine
} from "../../output.js";
import { prepareWorkspace } from "../../workspace-guard.js";
import { canonicalProjectRoot } from "../../project-root.js";
import {
  idlePolicyText
} from "./session-commands.js";

export interface GenerationStartOptions {
  project: string;
  config: string;
  context?: string | undefined;
  module?: string[] | undefined;
  device?: string | undefined;
  allowEvidenceDrift?: boolean | undefined;
  baseFlow?: string | undefined;
  externalFlow?: string[] | undefined;
  brief?: string | undefined;
  compact?: boolean | undefined;
  json?: boolean | undefined;
}

export interface GenerationObserveOptions {
  project: string;
  config: string;
  session: string;
  compact?: boolean | undefined;
  json?: boolean | undefined;
}

export interface GenerationStatusOptions extends GenerationObserveOptions {
  wait?: boolean | undefined;
  timeoutMs?: string | undefined;
}

export interface GenerationStepOptions extends GenerationObserveOptions {
  input?: string | undefined;
  replace?: string | undefined;
}

export interface GenerationConfirmOptions extends GenerationObserveOptions {
  challenge: string;
  decision?: string | undefined;
}

export interface GenerationManualOptions extends GenerationObserveOptions {
  action: "click" | "longClick" | "inputText" | "swipe" | "scrollTo" | "back" | "wait";
}

export interface GenerationBridgeOptions extends GenerationObserveOptions {
  scenario: string;
  triggerLocator: string;
  description?: string | undefined;
  returnTimeoutMs: string;
  flow?: string | undefined;
  escapeTimeoutMs?: string | undefined;
}

export interface GenerationFinalizeOptions extends GenerationObserveOptions {
  output: string;
  name?: string | undefined;
  device?: string | undefined;
  detach?: boolean | undefined;
}

export interface GenerationRecoverOptions extends GenerationObserveOptions {
  decision: string;
  expect?: string | undefined;
}

export interface GenerationReopenOptions extends GenerationObserveOptions {
  reason: string;
}

export interface GenerationConfigIdleOptions extends GenerationObserveOptions {
  strategy?: string | undefined;
  pollIntervalMs?: string | undefined;
  stablePolls?: string | undefined;
  timeoutMs?: string | undefined;
}

export interface GenerationListOptions {
  project: string;
  config: string;
  json?: boolean | undefined;
}

export type GenerationOptions =
  | GenerationStartOptions
  | GenerationObserveOptions
  | GenerationStepOptions
  | GenerationConfirmOptions
  | GenerationManualOptions
  | GenerationBridgeOptions
  | GenerationRecoverOptions
  | GenerationReopenOptions
  | GenerationFinalizeOptions
  | GenerationConfigIdleOptions
  | GenerationListOptions;

export const PlannerEnvelopeSchema = z.union([
  z.strictObject({
    version: z.literal(1),
    proposal: ProposedStepSchema,
    snapshot: RuntimeSnapshotSchema
  }),
  z.strictObject({
    version: z.literal(1),
    proposal: ProposedStepSchema,
    snapshotRef: z.string().min(1)
  })
]);

export const ManualActionSchema = z.enum([
  "click",
  "longClick",
  "inputText",
  "swipe",
  "scrollTo",
  "back",
  "wait"
]);

export function writeFailure(
  dependencies: CliDependencies,
  options: GenerationOptions,
  exitCode: 1 | 2 | 3 | 4,
  code: string,
  error: unknown,
  outputOptions: {
    status?: "error" | "recoveryRequired";
    details?: unknown;
    hint?: string;
    generationId?: string;
    timing?: GenerationStepTiming | undefined;
  } = {}
): void {
  const output = {
    status: outputOptions.status ?? "error",
    exitCode,
    ...(outputOptions.generationId === undefined
      ? {}
      : { generationId: outputOptions.generationId }),
    ...(outputOptions.timing === undefined
      ? {}
      : { timing: outputOptions.timing }),
    failure: {
      code,
      message: errorMessage(error),
      ...(outputOptions.details !== undefined
        ? { details: outputOptions.details }
        : error instanceof GenerationFinalizationError
          && error.details !== undefined
          ? { details: error.details }
        : error instanceof GenerationOperationError
          && error.details !== undefined
          ? { details: error.details }
          : {}),
      ...(outputOptions.hint === undefined ? {} : { hint: outputOptions.hint })
    }
  };
  if (options.json === true) {
    writeJson(dependencies.stdout, output);
  } else {
    writeLine(dependencies.stderr, output.failure.message);
  }
  dependencies.setExitCode(exitCode);
}

export async function loadConfig(
  dependencies: CliDependencies,
  options: { project: string; config: string }
): Promise<TapHoundConfig> {
  try {
    const config = TapHoundConfigSchema.parse(await dependencies.readJson(
      resolve(options.project, options.config)
    ));
    assertArtifactDirectory(options.project, config.artifactsDir);
    await prepareWorkspace(dependencies, options.project);
    return config;
  } catch (error) {
    throw new GenerationOperationError(
      "CONFIG_INVALID",
      errorMessage(error)
    );
  }
}

export async function generationConfig(
  dependencies: CliDependencies,
  options: GenerationOptions
): Promise<{
  projectRoot: string;
  config: TapHoundConfig;
}> {
  const projectRoot = await canonicalProjectRoot(
    dependencies.cwd(),
    options.project
  );
  return {
    projectRoot,
    config: await loadConfig(dependencies, {
      project: projectRoot,
      config: options.config
    })
  };
}

export function tools(
  checks: Awaited<ReturnType<CliDependencies["doctor"]["run"]>>["checks"]
): Record<string, string> {
  return Object.fromEntries(checks.flatMap((check) => (
    check.status === "passed" && check.version !== undefined
      ? [[check.name, check.version]]
      : []
  )));
}

export function writeSuccess(
  dependencies: CliDependencies,
  options: GenerationOptions,
  output: Record<string, unknown>,
  message: string
): void {
  if (options.json === true) {
    writeJson(dependencies.stdout, output);
  } else {
    writeLine(dependencies.stdout, message);
  }
  dependencies.setExitCode(0);
}

export function compactOutput(options: GenerationOptions): boolean {
  return "compact" in options && options.compact === true;
}

export function envelopeHint(options: GenerationOptions): string {
  if ("input" in options && options.input !== undefined) {
    return "Planner envelope must be a strict object with exactly three top-level fields: version (1), proposal (object), and either snapshot (the full RuntimeSnapshot object) or snapshotRef (the snapshotRef string from the preceding observe output). Unknown or missing fields are rejected. See docs/agent-integration.md and assets/skills/taphound-journey-generator/schemas/proposed-step-envelope.json.";
  }
  return "TapHound rejected the JSON input. See docs/agent-integration.md for the command contract.";
}

export function generationStatusText(status: GenerationRecoveryStatus): string {
  const verificationAttempt = status.verification.status === "running"
    || status.verification.status === "passed"
    || status.verification.status === "failed"
    ? ("attemptId" in status.verification
        ? status.verification.attemptId
        : "none")
    : "none";
  const owner = status.verification.status === "running"
    && status.verification.ownerPid !== undefined
    ? `${String(status.verification.ownerPid)} (${
        status.recovery.ownerAlive === null
          ? "unknown"
          : status.recovery.ownerAlive ? "alive" : "not alive"
      })`
    : "none";
  const phase = status.verification.status === "running"
    && status.verification.phase !== undefined
    ? verificationPhaseLabel(status.verification.phase)
    : null;
  const inFlight = status.inFlight === null
    ? "none"
    : `step ${String(status.inFlight.stepIndex)}, attempt ${status.inFlight.attemptId}`;
  const confirmation = status.pendingConfirmation === null
    ? "none"
    : `${status.pendingConfirmation.challengeId} (${
        status.pendingConfirmation.expired
          ? "expired"
          : status.pendingConfirmation.status
      }, expires ${status.pendingConfirmation.expiresAt})`;
  const recovery = status.recovery.available
    ? `${status.recovery.kind ?? "unknown"}; decision=${
        status.recovery.requiredDecision ?? "none"
      }; outcome=${status.recovery.attemptOutcome ?? "unknown"}`
    : "unavailable";
  return [
    `Generation: ${status.generationId}`,
    `State: ${status.state}`,
    `Revision: ${String(status.revision)}`,
    `Candidate steps: ${String(status.candidateStepCount)}`,
    ...(status.idlePolicy === undefined
      ? []
      : [`Idle policy: ${idlePolicyText(status.idlePolicy)}`]),
    `In flight: ${inFlight}`,
    `Pending confirmation: ${confirmation}`,
    `Verification: ${status.verification.status} (attempt ${verificationAttempt})`,
    `Verification owner: ${owner}`,
    ...(phase === null ? [] : [`Verification phase: ${phase}`]),
    `Publication: ${status.publication.status}`,
    `Recovery: ${recovery}`,
    `Action may have executed: ${
      status.recovery.actionMayHaveExecuted ? "yes" : "no"
    }`
  ].join("\n");
}

export function mappedFailure(
  dependencies: CliDependencies,
  options: GenerationOptions,
  error: unknown
): void {
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    writeFailure(dependencies, options, 2, "CONTEXT_INVALID", error, {
      hint: envelopeHint(options)
    });
    return;
  }
  if (error instanceof ContextLoadError) {
    const hint = contextLoadHint(error);
    writeFailure(
      dependencies,
      options,
      error.code === "CONTEXT_STALE" ? 1 : 2,
      error.code,
      error,
      hint === undefined ? {} : { hint }
    );
    return;
  }
  if (dependencies.signal?.aborted === true) {
    writeFailure(
      dependencies,
      options,
      1,
      "RECOVERY_REQUIRED",
      "Generation command was cancelled"
    );
    return;
  }
  if (error instanceof GenerationFinalizationError) {
    writeFailure(dependencies, options, 1, error.code, error);
    return;
  }
  if (error instanceof GenerationOperationError) {
    const exitCode = error.code === "CONFIG_INVALID"
      || error.code === "CONTEXT_INVALID"
      || error.code === "BRIEF_INVALID"
      || error.code === "FLOW_INVALID"
      || error.code === "EXTERNAL_FLOW_NOT_FOUND"
      || error.code === "EXTERNAL_FLOW_STALE"
      || error.code === "EXTERNAL_LOCATOR_STRICTNESS"
      ? 2
      : error.code === "EXTERNAL_PACKAGE_MISMATCH"
        || error.code === "EXTERNAL_ACTIVITY_MISMATCH"
        || error.code === "EXTERNAL_STEP_FAILED"
      ? 1
      : 1;
    writeFailure(dependencies, options, exitCode, error.code, error);
    return;
  }
  if (error instanceof GenerationSessionStoreError) {
    const exitCode = error.code === "INVALID_ID"
      || error.code === "INVALID_SESSION"
      || error.code === "INVALID_REVISION"
      ? 2
      : error.code === "IO_ERROR" || error.code === "LOCK_TIMEOUT"
        ? 4
        : 1;
    writeFailure(dependencies, options, exitCode, error.code, error);
    return;
  }
  if (
    error instanceof GenerationPromptCancelledError
  ) {
    writeFailure(
      dependencies,
      options,
      1,
      "RECOVERY_REQUIRED",
      error
    );
    return;
  }
  if (
    error instanceof Error
    && error.message.includes("requires local TTY")
  ) {
    writeFailure(
      dependencies,
      options,
      1,
      "RISK_CONFIRMATION_REQUIRED",
      error
    );
    return;
  }
  const failureCode = failureCodeFromUnknown(error);
  if (failureCode !== undefined) {
    writeFailure(
      dependencies,
      options,
      exitCodeForFailure(failureCode),
      failureCode,
      error
    );
    return;
  }
  writeFailure(dependencies, options, 4, "INTERNAL_ERROR", error);
}

export async function executeApproved(
  dependencies: CliDependencies,
  options: GenerationOptions,
  runtime: NonNullable<ReturnType<NonNullable<CliDependencies["generationRuntime"]>>>,
  input: {
    generationId: string;
    proposal: z.infer<typeof ProposedStepSchema>;
    snapshot: z.infer<typeof RuntimeSnapshotSchema>;
    source: "planner" | "manualOverride";
  }
): Promise<void> {
  const result = await runtime.executor.execute({
    ...input,
    ...(dependencies.signal === undefined
      ? {}
      : { signal: dependencies.signal })
  });
  if (result.status !== "succeeded") {
    writeFailure(
      dependencies,
      options,
      1,
      result.failure.code,
      result.failure.message,
      {
        status: "recoveryRequired",
        generationId: input.generationId,
        ...(result.timing === undefined ? {} : { timing: result.timing }),
        ...(result.failure.details === undefined
          ? {}
          : { details: result.failure.details })
      }
    );
    return;
  }
  const session = await runtime.readSession(input.generationId);
  writeSuccess(dependencies, options, {
    status: "succeeded",
    exitCode: 0,
    generationId: input.generationId,
    revision: session.revision,
    stepIndex: session.candidateSteps.length - 1,
    step: result.step,
    source: input.source,
    ...(result.timing === undefined ? {} : { timing: result.timing }),
    ...(result.nextObservation === undefined
      ? {}
      : compactOutput(options)
        ? {
            nextBinding: result.nextObservation.binding,
            nextSnapshotRef: result.nextObservation.snapshotRef
          }
        : {
            nextBinding: result.nextObservation.binding,
            nextSnapshot: result.nextObservation.snapshot,
            nextSnapshotRef: result.nextObservation.snapshotRef
          }),
    ...(result.nextObservationFailure === undefined
      ? {}
      : { nextObservationFailure: result.nextObservationFailure })
  }, `Generation step ${String(session.candidateSteps.length - 1)} succeeded`);
}

export function requireRuntime(
  dependencies: CliDependencies,
  projectRoot: string,
  config: TapHoundConfig
): NonNullable<ReturnType<NonNullable<CliDependencies["generationRuntime"]>>> {
  if (dependencies.generationRuntime === undefined) {
    throw new Error("Generation command runtime is unavailable");
  }
  return dependencies.generationRuntime({
    projectRoot,
    config
  });
}

export async function assertRuntimeConfig(
  runtime: NonNullable<ReturnType<NonNullable<CliDependencies["generationRuntime"]>>>,
  generationId: string
): Promise<void> {
  await runtime.assertConfigIdentity(generationId);
}

export function addCommonOptions(
  command: Command,
  dependencies: CliDependencies
): Command {
  return command
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", CONFIG_PATH)
    .requiredOption("--session <id>", "Generation session id")
    .option("--json", "Emit one machine-readable JSON value");
}
