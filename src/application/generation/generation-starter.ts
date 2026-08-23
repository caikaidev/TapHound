import { createHash } from "node:crypto";

import type {
  ContextValidator
} from "../context/context-validator.js";
import type {
  ProjectDescription
} from "../project/project-describer.js";
import {
  GenerationSessionSchema,
  GenerationExternalFlowBindingSchema,
  type GenerationErrorCode,
  type GenerationSession
} from "../../domain/generation.js";
import {
  ResolvedProjectContextSchema,
  type ResolvedProjectContext
} from "../../domain/project-context.js";
import {
  TapHoundConfigSchema,
  type TapHoundConfig
} from "../../domain/config.js";
import type {
  GenerationSessionStore
} from "../../ports/generation-session-store.js";
import {
  JourneySchema,
  type Journey,
  type JourneyStep
} from "../../domain/journey.js";
import { normalizeActivity } from "../../domain/activity.js";
import { FlowNameSchema } from "../../domain/journey-composition.js";
import {
  TapHoundReportSchema,
  hashJourney,
  type TapHoundReport
} from "../../domain/report.js";
import type {
  GenerationAppPreparer
} from "./generation-app-preparer.js";

export interface GenerationRecoveryDetails {
  diagnostics: readonly {
    code: string;
    message: string;
  }[];
  recovery: readonly string[];
}

export class GenerationOperationError extends Error {
  public override readonly name = "GenerationOperationError";

  public constructor(
    public readonly code: GenerationErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export interface GenerationExternalFlowInput {
  name: string;
  flowSha256: string;
  escapedPackageName: string;
  stepCount: number;
}

export interface GenerationStartInput {
  projectRoot: string;
  config: TapHoundConfig;
  context: ResolvedProjectContext;
  project: ProjectDescription;
  deviceSerial: string;
  signal?: AbortSignal | undefined;
  allowEvidenceDrift?: boolean | undefined;
  baseFlow?: {
    name: string;
    resolutionSha256: string;
    journey: Journey;
    verificationReport: TapHoundReport;
    verificationReportPath: string;
  } | undefined;
  externalFlows?: readonly GenerationExternalFlowInput[] | undefined;
}

export interface GenerationStarterDependencies {
  contextValidator: Pick<ContextValidator, "validate">;
  appPreparer: Pick<GenerationAppPreparer, "prepare">;
  store: Pick<GenerationSessionStore, "create">;
  now: () => Date;
  generateId: () => string;
  randomBytes: (size: number) => Uint8Array;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

export function hashGenerationBinding(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function randomHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function failedFlowStepSummary(
  step: JourneyStep | undefined,
  stepIndex: number | undefined
): unknown {
  if (step === undefined || stepIndex === undefined) {
    return null;
  }
  return {
    stepIndex,
    action: step.action,
    activity: step.activity,
    ...("locator" in step ? { locator: step.locator } : {}),
    ...(step.expect === undefined ? {} : { expectation: step.expect })
  };
}

export function flowReplayFailureDetails(input: {
  flowName: string;
  reportPath: string;
  journey: Journey;
  report: TapHoundReport;
}): unknown {
  const primaryFailure = input.report.primaryFailure;
  const stepIndex = primaryFailure?.stepIndex;
  const relatedStepIndex = stepIndex
    ?? (primaryFailure?.phase === "readiness" ? 0 : undefined);
  return {
    flowName: input.flowName,
    reportPath: input.reportPath,
    primaryFailure: primaryFailure === undefined
      ? null
      : {
          code: primaryFailure.code,
          phase: primaryFailure.phase,
          stepIndex: stepIndex ?? null
        },
    failedStep: failedFlowStepSummary(
      relatedStepIndex === undefined
        ? undefined
        : input.journey.steps[relatedStepIndex],
      relatedStepIndex
    ),
    recovery: [
      "Check that the first Flow step starts from a stable Activity deterministically reached after cold launch.",
      "Replace a transient Splash transition with a Home readiness anchor such as wait: Home -> Home plus an expectation for a unique Home element.",
      "Repair or re-record the Flow, then retry generation start.",
      "Omit --base-flow only when the user explicitly chooses to bypass reuse."
    ]
  };
}

function distinctId(
  generationId: string,
  generateId: () => string
): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = generateId();
    if (candidate !== generationId) {
      return candidate;
    }
  }
  throw new Error("Unable to generate a distinct Journey run ID");
}

export class GenerationStarter {
  public constructor(
    private readonly dependencies: GenerationStarterDependencies
  ) {}

  public readonly start = async (
    input: GenerationStartInput
  ): Promise<GenerationSession> => {
    const config = TapHoundConfigSchema.parse(input.config);
    if (input.project.projectRoot !== input.projectRoot) {
      throw new GenerationOperationError(
        "CONFIG_INVALID",
        "Project description root does not match requested project root"
      );
    }
    if (input.project.packageName !== config.run.packageName) {
      throw new GenerationOperationError(
        "CONFIG_INVALID",
        "Project package does not match configured package"
      );
    }
    const validation = await this.dependencies.contextValidator.validate({
      context: input.context,
      projectRoot: input.projectRoot,
      config
    });
    if (
      validation.status !== "valid"
      && !(validation.status === "stale" && input.allowEvidenceDrift === true)
    ) {
      throw new GenerationOperationError(
        validation.status === "stale" ? "CONTEXT_STALE" : "CONTEXT_INVALID",
        validation.reason.message
      );
    }
    const context = ResolvedProjectContextSchema.parse(input.context);
    if (
      context.packageName !== input.project.packageName
      || context.launchActivity !== input.project.launchActivity
    ) {
      throw new GenerationOperationError(
        "CONTEXT_INVALID",
        "Context package and launch identity do not match the project"
      );
    }

    const baseFlow = input.baseFlow === undefined
      ? undefined
      : ((): {
          journey: Journey;
          binding: NonNullable<GenerationSession["baseFlow"]>;
        } => {
          const journey = JourneySchema.parse(input.baseFlow.journey);
          const report = TapHoundReportSchema.parse(
            input.baseFlow.verificationReport
          );
          const journeySha256 = hashJourney(journey);
          if (
            report.status !== "passed"
            || report.primaryFailure !== undefined
            || report.secondaryErrors.length !== 0
            || report.fallbackUsed
            || Object.values(report.layers).some(
              (status) => status !== "passed"
            )
            || report.journey.name !== journey.name
            || report.journey.sha256 !== journeySha256
            || report.steps.length !== journey.steps.length
            || report.project.root !== input.projectRoot
            || report.project.packageName !== config.run.packageName
            || report.project.launchActivity !== normalizeActivity(
              config.run.packageName,
              config.run.activity
            )
            || report.environment.deviceSerial !== input.deviceSerial
            || journey.steps.some((step, index) => {
              const result = report.steps[index];
              const expectationType = step.expect?.type;
              const requiresLocator = step.action === "click"
                || step.action === "longClick"
                || step.action === "swipe";
              return result === undefined
                || result.index !== index
                || result.action !== step.action
                || result.status !== "passed"
                || result.activity?.before.status !== "passed"
                || result.activity.before.expected !== step.activity.before
                || result.activity.before.actual !== step.activity.before
                || result.activity.after.status !== "passed"
                || result.activity.after.expected !== step.activity.after
                || result.activity.after.actual !== step.activity.after
                || (
                  expectationType === undefined
                    ? result.expectation !== undefined
                    : (
                        result.expectation?.type !== expectationType
                        || result.expectation.status !== "passed"
                      )
                )
                || (
                  requiresLocator
                    ? (
                        result.locator?.status !== "found"
                        || result.locator.fallbackUsed
                      )
                    : result.locator !== undefined
                )
                || result.locator?.fallbackUsed === true;
            })
          ) {
            throw new GenerationOperationError(
              "FLOW_REPLAY_FAILED",
              "Base Flow requires a clean exact replay before generation",
              flowReplayFailureDetails({
                flowName: input.baseFlow.name,
                reportPath: input.baseFlow.verificationReportPath,
                journey,
                report
              })
            );
          }
          return {
            journey,
            binding: {
              name: FlowNameSchema.parse(input.baseFlow.name),
              resolutionSha256: input.baseFlow.resolutionSha256,
              journeySha256,
              verificationReportSha256: hashGenerationBinding(report),
              verificationRunId: report.runId,
              stepCount: journey.steps.length
            }
          };
        })();

    if (baseFlow === undefined) {
      try {
        await this.dependencies.appPreparer.prepare({
          config,
          deviceSerial: input.deviceSerial,
          ...(input.signal === undefined ? {} : { signal: input.signal })
        });
      } catch (error) {
        throw new GenerationOperationError(
          "APP_LAUNCH_FAILED",
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    const externalFlowBindings = input.externalFlows === undefined
      ? []
      : input.externalFlows.map((entry) => GenerationExternalFlowBindingSchema.parse({
        name: FlowNameSchema.parse(entry.name),
        flowSha256: entry.flowSha256,
        escapedPackageName: entry.escapedPackageName,
        stepCount: entry.stepCount
      }));

    const generationId = this.dependencies.generateId();
    const runId = distinctId(generationId, this.dependencies.generateId);
    const session = GenerationSessionSchema.parse({
      version: 1,
      id: generationId,
      revision: 0,
      state: "active",
      bindings: {
        projectHash: hashGenerationBinding(input.project),
        configHash: hashGenerationBinding(config),
        contextHash: hashGenerationBinding(context),
        snapshotHash: null
      },
      target: {
        packageName: config.run.packageName,
        deviceSerial: input.deviceSerial,
        resetStrategy: "processOnly",
        interactionPolicy: context.interactionPolicy
      },
      contextSelection: context.selection,
      variables: {
        runId,
        timestamp: this.dependencies.now().toISOString(),
        randomHex: randomHex(this.dependencies.randomBytes(16))
      },
      ...(baseFlow === undefined ? {} : { baseFlow: baseFlow.binding }),
      externalFlows: externalFlowBindings,
      candidateSteps: baseFlow?.journey.steps ?? [],
      candidateSources: baseFlow?.journey.steps.map(() => "flow") ?? [],
      inFlight: null,
      pendingConfirmation: null,
      verification: { status: "notRun" },
      publication: { status: "notRun" }
    });

    await this.dependencies.store.create(session);
    return session;
  };
}
