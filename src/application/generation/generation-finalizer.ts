import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, extname } from "node:path";

import { z } from "zod";

import {
  normalizeActivity
} from "../../domain/activity.js";
import {
  GenerationMetaSchema,
  GenerationReportSchema,
  GenerationSessionSchema,
  type GenerationErrorCode,
  type GenerationMeta,
  type GenerationSession
} from "../../domain/generation.js";
import { JourneySchema, type Journey } from "../../domain/journey.js";
import {
  ProjectContextSchema,
  ProjectRelativePathSchema,
  type ProjectContext
} from "../../domain/project-context.js";
import {
  hashJourney,
  TapHoundReportSchema,
  type TapHoundReport
} from "../../domain/report.js";
import {
  TapHoundConfigSchema,
  type TapHoundConfig
} from "../../domain/config.js";
import type { AdbPort } from "../../ports/adb.js";
import {
  GenerationSessionStoreError,
  type GenerationSessionStore
} from "../../ports/generation-session-store.js";
import type {
  ContextValidator
} from "../context/context-validator.js";
import type {
  ProjectDescription
} from "../project/project-describer.js";
import type {
  VerifyInput,
  VerifyResult,
  VerifyRuntime
} from "../runtime/verify-runtime.js";
import {
  GENERATION_BUNDLE_PATHS,
  GenerationPublisher
} from "./generation-publisher.js";
import { hashGenerationBinding } from "./generation-starter.js";

const Sha256Schema = z.string().regex(/^[a-f\d]{64}$/);

const ProjectDescriptionSchema: z.ZodType<ProjectDescription> = z.strictObject({
  projectRoot: z.string().min(1),
  packageName: z.string().min(1),
  buildTask: z.string().min(1),
  artifactTarget: z.string().min(1),
  variant: z.string().min(1),
  launchActivity: z.string().min(1),
  apkPath: z.string().min(1),
  metadataPaths: z.array(z.string()),
  metadataPackageName: z.string().optional()
});

const VerificationReceiptSchema = z.strictObject({
  version: z.literal(1),
  generationId: z.string().min(1),
  attemptId: z.string().min(1),
  journey: z.strictObject({
    name: z.string().min(1),
    sha256: Sha256Schema
  }),
  project: z.strictObject({
    root: z.string().min(1),
    packageName: z.string().min(1),
    launchActivity: z.string().min(1)
  }),
  deviceSerial: z.string().min(1),
  bindings: z.strictObject({
    projectHash: Sha256Schema,
    configHash: Sha256Schema,
    contextHash: Sha256Schema,
    snapshotHash: Sha256Schema.nullable()
  }),
  tools: z.record(z.string(), z.string()),
  report: z.strictObject({
    path: z.literal(GENERATION_BUNDLE_PATHS.verificationReport),
    sha256: Sha256Schema,
    runId: z.string().min(1)
  })
});

type VerificationReceipt = z.infer<typeof VerificationReceiptSchema>;

interface ExpectedVerification {
  generationId: string;
  attemptId: string;
  journey: VerificationReceipt["journey"];
  project: VerificationReceipt["project"];
  deviceSerial: string;
  bindings: VerificationReceipt["bindings"];
  tools: Record<string, string>;
}

export const GenerationOutputPathSchema = ProjectRelativePathSchema.refine(
  (path) => path.split("/").every(
    (segment) => segment.length > 0 && segment !== "."
  ),
  "Generation output path must be normalized"
).refine(
  (path) => (
    path !== ".taphound/generations"
    && !path.startsWith(".taphound/generations/")
  ),
  "Generation output cannot overlap the authoritative bundle"
);

export type GenerationFinalizationStage =
  | "precondition"
  | "verification"
  | "publication"
  | "export";

export class GenerationFinalizationError extends Error {
  public override readonly name = "GenerationFinalizationError";

  public constructor(
    public readonly code: GenerationErrorCode,
    public readonly stage: GenerationFinalizationStage,
    public readonly recoverable: boolean,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export interface GenerationFinalizeInput {
  generationId: string;
  projectRoot: string;
  config: TapHoundConfig;
  context: ProjectContext;
  project: ProjectDescription;
  outputPath: string;
  name?: string | undefined;
  deviceSerial: string;
  toolVersions: Record<string, string>;
  signal?: AbortSignal | undefined;
}

export interface GenerationFinalizerDependencies {
  store: Pick<
    GenerationSessionStore,
    | "read"
    | "beginVerification"
    | "completeVerification"
    | "failVerification"
    | "markBundlePublishable"
    | "writeTextEvidence"
    | "readEvidence"
  >;
  contextValidator: Pick<ContextValidator, "validate">;
  adb: Pick<AdbPort, "forceStop">;
  verifyRuntime: Pick<VerifyRuntime, "verify">;
  publisher: GenerationPublisher;
  generateAttemptId: () => string;
}

export interface GenerationFinalizeResult {
  status: "verified";
  journey: Journey;
  meta: GenerationMeta;
  bundlePath: string;
  journeyPath: string;
  metaPath: string;
  replayed: boolean;
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function commandFailed(result: {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  spawnError?: string | undefined;
}): boolean {
  return result.exitCode !== 0
    || result.timedOut
    || result.cancelled
    || result.spawnError !== undefined;
}

function derivedJourneyName(outputPath: string): string {
  const file = basename(outputPath);
  const extension = extname(file);
  const stem = extension.length === 0 ? file : file.slice(0, -extension.length);
  return stem.trim() || "Generated Journey";
}

function sameSession(
  left: GenerationSession,
  right: GenerationSession
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalTools(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(z.record(z.string(), z.string()).parse(input))
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function locatorMatchIsEligible(
  matchedBy: "resourceId" | "text" | "contentDescription" | undefined,
  step: Journey["steps"][number]
): boolean {
  if (
    step.action !== "click"
    && step.action !== "longClick"
    && step.action !== "swipe"
  ) {
    return matchedBy === undefined;
  }
  return matchedBy !== undefined && step.locator[matchedBy] !== undefined;
}

function failure(
  code: GenerationErrorCode,
  stage: GenerationFinalizationStage,
  message: string,
  recoverable = false,
  cause?: unknown
): GenerationFinalizationError {
  return new GenerationFinalizationError(
    code,
    stage,
    recoverable,
    message,
    cause === undefined ? undefined : { cause }
  );
}

export class GenerationFinalizer {
  public constructor(
    private readonly dependencies: GenerationFinalizerDependencies
  ) {}

  public readonly finalize = async (
    input: GenerationFinalizeInput
  ): Promise<GenerationFinalizeResult> => {
    const config = TapHoundConfigSchema.parse(input.config);
    const context = ProjectContextSchema.parse(input.context);
    const project = ProjectDescriptionSchema.parse(input.project);
    const canonicalProjectRoot = await realpath(input.projectRoot);
    const outputPath = GenerationOutputPathSchema.parse(input.outputPath);
    const name = input.name === undefined
      ? derivedJourneyName(outputPath)
      : z.string().trim().min(1).parse(input.name);
    let session = GenerationSessionSchema.parse(
      await this.dependencies.store.read(input.generationId)
    );
    this.assertBindings(session, input, config, context, project);

    const journey = JourneySchema.parse({
      version: 1,
      name,
      steps: session.candidateSteps
    });
    let replayed = false;
    let verificationReport: TapHoundReport | undefined;

    if (session.verification.status === "notRun") {
      const begun = await this.beginVerification(session);
      session = begun.session;
      if (
        !begun.owned
        && session.verification.status === "failed"
      ) {
        throw failure(
          "VERIFICATION_FAILED",
          "verification",
          session.verification.failure.message
        );
      }
      const expected = this.expectedVerification(
        session,
        journey,
        config,
        canonicalProjectRoot,
        input.toolVersions
      );
      if (!begun.owned) {
        if (session.verification.status === "passed") {
          verificationReport = await this.readVerifiedReport(session, expected);
        } else {
          let reconciled:
            | { session: GenerationSession; report: TapHoundReport }
            | undefined;
          try {
            reconciled = session.verification.status === "running"
              ? await this.reconcilePassedVerification(
                  session,
                  expected,
                  () => this.revalidate(
                    input,
                    config,
                    context,
                    project,
                    session
                  )
                )
              : undefined;
          } catch (error) {
            await this.persistFailedVerification(session, error);
            throw failure(
              "VERIFICATION_FAILED",
              "verification",
              error instanceof Error
                ? error.message
                : "Immutable verification receipt is invalid",
              false,
              error
            );
          }
          if (reconciled === undefined) {
            throw failure(
              "FINALIZATION_IN_PROGRESS",
              "verification",
              "Another finalizer owns verification",
              true
            );
          }
          session = reconciled.session;
          verificationReport = reconciled.report;
        }
      }
      if (begun.owned) {
        try {
        await this.revalidate(input, config, context, project, session);
        if (input.signal?.aborted === true) {
          throw failure(
            "VERIFICATION_FAILED",
            "verification",
            "Generation finalization was cancelled"
          );
        }
        const stopped = await this.dependencies.adb.forceStop({
          packageName: session.target.packageName,
          deviceSerial: session.target.deviceSerial,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          timeoutMs: config.idle.timeoutMs
        });
        if (commandFailed(stopped)) {
          throw failure(
            "VERIFICATION_FAILED",
            "verification",
            stopped.stderr.trim()
              || stopped.spawnError
              || "Unable to reset the generated Journey process"
          );
        }
        const result = await this.dependencies.verifyRuntime.verify({
          config,
          journey,
          projectRoot: canonicalProjectRoot,
          deviceSerial: input.deviceSerial,
          toolVersions: input.toolVersions,
          requireFocusedInput: true,
          generatedReplayPolicy: true,
          ...(input.signal === undefined ? {} : { signal: input.signal })
        } satisfies VerifyInput);
        replayed = true;
        await this.revalidate(input, config, context, project, session);
        this.assertEligible(result, journey, expected);
        verificationReport = TapHoundReportSchema.parse(result.report);
        session = await this.persistPassedVerification(
          session,
          verificationReport,
          expected
        );
        } catch (error) {
          if (
            session.verification.status === "running"
            && !(error instanceof GenerationFinalizationError
              && error.code === "FINALIZATION_IN_PROGRESS")
          ) {
            await this.persistFailedVerification(session, error);
          }
          throw error instanceof GenerationFinalizationError
            ? error
            : failure(
                "VERIFICATION_FAILED",
                "verification",
                error instanceof Error
                  ? error.message
                  : "Generation verification failed",
                false,
                error
              );
        }
      }
    } else if (session.verification.status === "running") {
      const expected = this.expectedVerification(
        session,
        journey,
        config,
        canonicalProjectRoot,
        input.toolVersions
      );
      let reconciled:
        | { session: GenerationSession; report: TapHoundReport }
        | undefined;
      try {
        reconciled = await this.reconcilePassedVerification(
          session,
          expected,
          () => this.revalidate(
            input,
            config,
            context,
            project,
            session
          )
        );
      } catch (error) {
        await this.persistFailedVerification(session, error);
        throw failure(
          "VERIFICATION_FAILED",
          "verification",
          error instanceof Error
            ? error.message
            : "Immutable verification receipt is invalid",
          false,
          error
        );
      }
      if (reconciled === undefined) {
        throw failure(
          "FINALIZATION_IN_PROGRESS",
          "verification",
          "Generation verification is already running or cannot be safely reconciled",
          true
        );
      }
      session = reconciled.session;
      verificationReport = reconciled.report;
    } else if (session.verification.status === "failed") {
      throw failure(
        "VERIFICATION_FAILED",
        "verification",
        session.verification.failure.message
      );
    } else {
      verificationReport = await this.readVerifiedReport(
        session,
        this.expectedVerification(
          session,
          journey,
          config,
          canonicalProjectRoot,
          input.toolVersions
        )
      );
    }

    if (verificationReport === undefined) {
      throw failure(
        "RECOVERY_REQUIRED",
        "verification",
        "Verification completed without durable report evidence"
      );
    }
    this.assertReport(
      verificationReport,
      journey,
      this.expectedVerification(
        session,
        journey,
        config,
        canonicalProjectRoot,
        input.toolVersions
      ),
      "RECOVERY_REQUIRED"
    );
    this.assertBindings(session, input, config, context, project);
    const meta = this.buildMeta(session, outputPath, verificationReport);
    const generationReport = GenerationReportSchema.parse({
      version: 1,
      generationId: session.id,
      status: "verified",
      steps: session.candidateSources.map((source, index) => ({
        index,
        source
      }))
    });

    if (session.publication.status === "notRun") {
      try {
        await this.dependencies.publisher.stage({
          generationId: session.id,
          journey,
          report: generationReport,
          verificationReport,
          meta
        });
        const publishable = GenerationSessionSchema.parse({
          ...session,
          revision: session.revision + 1,
          publication: {
            status: "published",
            journeyPath: outputPath
          }
        });
        try {
          await this.dependencies.store.markBundlePublishable(
            session.id,
            session.revision,
            publishable
          );
        } catch (error) {
          const latest = GenerationSessionSchema.parse(
            await this.dependencies.store.read(session.id)
          );
          if (!sameSession(latest, publishable)) {
            throw error;
          }
        }
        session = publishable;
      } catch (error) {
        throw failure(
          "PUBLICATION_FAILED",
          "publication",
          error instanceof Error ? error.message : "Bundle staging failed",
          true,
          error
        );
      }
    } else if (
      session.publication.status !== "published"
      || session.publication.journeyPath !== outputPath
    ) {
      throw failure(
        "PUBLICATION_FAILED",
        "publication",
        "Published generation output path does not match the requested path"
      );
    }

    let bundlePath: string;
    try {
      bundlePath = await this.dependencies.publisher.publish(session.id);
    } catch (error) {
      try {
        bundlePath = await this.dependencies.publisher.publish(session.id);
      } catch {
        throw failure(
          "PUBLICATION_FAILED",
          "publication",
          "Authoritative generation bundle publication is ambiguous",
          true,
          error
        );
      }
    }

    try {
      const exported = await this.dependencies.publisher.export({
        generationId: session.id,
        projectRoot: input.projectRoot,
        journeyPath: outputPath,
        journey,
        meta
      });
      return {
        status: "verified",
        journey,
        meta,
        bundlePath,
        journeyPath: exported.journeyPath,
        metaPath: exported.metaPath,
        replayed
      };
    } catch (error) {
      throw failure(
        "EXPORT_FAILED",
        "export",
        "Authoritative bundle was published but Journey export failed",
        true,
        error
      );
    }
  };

  private assertBindings(
    session: GenerationSession,
    input: GenerationFinalizeInput,
    config: TapHoundConfig,
    context: ProjectContext,
    project: ProjectDescription
  ): void {
    if (
      input.projectRoot !== project.projectRoot
      || input.deviceSerial !== session.target.deviceSerial
      || project.packageName !== session.target.packageName
      || session.target.packageName !== config.run.packageName
      || normalizeActivity(
        project.packageName,
        project.launchActivity
      ) !== normalizeActivity(config.run.packageName, config.run.activity)
      || session.inFlight !== null
      || session.pendingConfirmation !== null
      || session.state !== "active"
      || session.bindings.projectHash !== hashGenerationBinding(project)
      || session.bindings.configHash !== hashGenerationBinding(config)
      || session.bindings.contextHash !== hashGenerationBinding(context)
      || JSON.stringify(session.target.interactionPolicy)
        !== JSON.stringify(context.interactionPolicy)
    ) {
      throw failure(
        "CONTEXT_STALE",
        "precondition",
        "Generation identity, context, configuration, or process-only binding changed"
      );
    }
  }

  private async revalidate(
    input: GenerationFinalizeInput,
    config: TapHoundConfig,
    context: ProjectContext,
    project: ProjectDescription,
    session: GenerationSession
  ): Promise<void> {
    this.assertBindings(session, input, config, context, project);
    const result = await this.dependencies.contextValidator.validate({
      context,
      projectRoot: input.projectRoot,
      config
    });
    if (result.status !== "valid") {
      throw failure(
        result.status === "stale" ? "CONTEXT_STALE" : "CONTEXT_INVALID",
        "precondition",
        result.reason.message
      );
    }
  }

  private async beginVerification(
    session: GenerationSession
  ): Promise<{ session: GenerationSession; owned: boolean }> {
    const attemptId = this.dependencies.generateAttemptId();
    const expected = GenerationSessionSchema.parse({
      ...session,
      revision: session.revision + 1,
      verification: { status: "running", attemptId }
    });
    try {
      return {
        session: await this.dependencies.store.beginVerification(
          session.id,
          session.revision,
          attemptId
        ),
        owned: true
      };
    } catch (error) {
      const latest = GenerationSessionSchema.parse(
        await this.dependencies.store.read(session.id)
      );
      if (sameSession(latest, expected)) {
        return { session: latest, owned: true };
      }
      if (latest.verification.status !== "notRun") {
        return { session: latest, owned: false };
      }
      throw error;
    }
  }

  private expectedVerification(
    session: GenerationSession,
    journey: Journey,
    config: TapHoundConfig,
    canonicalProjectRoot: string,
    tools: Record<string, string>
  ): ExpectedVerification {
    if (
      session.verification.status !== "running"
      && session.verification.status !== "passed"
    ) {
      throw failure(
        "RECOVERY_REQUIRED",
        "verification",
        "Generation verification attempt identity is unavailable"
      );
    }
    return {
      generationId: session.id,
      attemptId: session.verification.attemptId,
      journey: {
        name: journey.name,
        sha256: hashJourney(journey)
      },
      project: {
        root: canonicalProjectRoot,
        packageName: session.target.packageName,
        launchActivity: normalizeActivity(
          session.target.packageName,
          config.run.activity
        )
      },
      deviceSerial: session.target.deviceSerial,
      bindings: { ...session.bindings },
      tools: canonicalTools(tools)
    };
  }

  private assertEligible(
    result: VerifyResult,
    journey: Journey,
    expected: ExpectedVerification
  ): void {
    if (
      result.status !== "passed"
      || result.exitCode !== 0
    ) {
      throw failure(
        "VERIFICATION_FAILED",
        "verification",
        "Generated replay did not pass cleanly"
      );
    }
    this.assertReport(result.report, journey, expected, "VERIFICATION_FAILED");
  }

  private assertReport(
    report: TapHoundReport,
    journey: Journey,
    expected: ExpectedVerification,
    code: "VERIFICATION_FAILED" | "RECOVERY_REQUIRED"
  ): void {
    if (
      report.status !== "passed"
      || report.fallbackUsed
      || report.primaryFailure !== undefined
      || report.secondaryErrors.length !== 0
      || Object.values(report.layers).some((status) => status !== "passed")
      || report.journey.name !== journey.name
      || report.journey.sha256 !== hashJourney(journey)
      || report.project.root !== expected.project.root
      || report.project.packageName !== expected.project.packageName
      || report.project.launchActivity !== expected.project.launchActivity
      || report.environment.deviceSerial !== expected.deviceSerial
      || !sameJson(canonicalTools(report.environment.tools), expected.tools)
      || report.steps.length !== journey.steps.length
    ) {
      throw failure(
        code,
        "verification",
        "Verification report does not match the exact generated replay"
      );
    }
    for (const [index, candidate] of journey.steps.entries()) {
      const step = report.steps[index];
      const expectationType = candidate.expect?.type;
      const hasLocator = candidate.action === "click"
        || candidate.action === "longClick"
        || candidate.action === "swipe";
      const isScrollTo = candidate.action === "scrollTo";
      if (
        step === undefined
        || step.index !== index
        || step.action !== candidate.action
        || step.status !== "passed"
        || step.activity === undefined
        || step.activity.before.status !== "passed"
        || step.activity.before.expected !== candidate.activity.before
        || step.activity.before.actual !== candidate.activity.before
        || step.activity.after.status !== "passed"
        || step.activity.after.expected !== candidate.activity.after
        || step.activity.after.actual !== candidate.activity.after
        || (
          expectationType === undefined
            ? step.expectation !== undefined
            : (
                step.expectation === undefined
                || step.expectation.type !== expectationType
                || step.expectation.status !== "passed"
              )
        )
        || (
          !hasLocator
            ? step.locator !== undefined
            : (
            step.locator === undefined
            || step.locator.status !== "found"
            || step.locator.fallbackUsed
            || !locatorMatchIsEligible(step.locator.matchedBy, candidate)
          )
        )
        || step.locator?.fallbackUsed === true
        || (
          isScrollTo
            ? (
                step.scroll === undefined
                || step.scroll.maxSwipes !== candidate.maxSwipes
                || step.scroll.swipesUsed > candidate.maxSwipes
                || step.idle !== undefined
              )
            : (
                step.scroll !== undefined
                || step.idle === undefined
                || step.idle.status !== "stable"
              )
        )
      ) {
        throw failure(
          code,
          "verification",
          `Verification report step ${String(index)} does not match the candidate`
        );
      }
    }
  }

  private receiptMatches(
    receipt: VerificationReceipt,
    expected: ExpectedVerification
  ): boolean {
    return receipt.generationId === expected.generationId
      && receipt.attemptId === expected.attemptId
      && sameJson(receipt.journey, expected.journey)
      && sameJson(receipt.project, expected.project)
      && receipt.deviceSerial === expected.deviceSerial
      && sameJson(receipt.bindings, expected.bindings)
      && sameJson(canonicalTools(receipt.tools), expected.tools);
  }

  private async persistPassedVerification(
    running: GenerationSession,
    report: TapHoundReport,
    expected: ExpectedVerification
  ): Promise<GenerationSession> {
    if (running.verification.status !== "running") {
      throw failure(
        "RECOVERY_REQUIRED",
        "verification",
        "Verification cannot pass without exact running-attempt ownership"
      );
    }
    const reportBytes = serializeJson(report);
    await this.ensureVerificationEvidence(
      running.id,
      GENERATION_BUNDLE_PATHS.verificationReport,
      reportBytes
    );
    const receipt = VerificationReceiptSchema.parse({
      version: 1,
      ...expected,
      report: {
        path: GENERATION_BUNDLE_PATHS.verificationReport,
        sha256: sha256(reportBytes),
        runId: report.runId
      }
    });
    await this.ensureVerificationEvidence(
      running.id,
      GENERATION_BUNDLE_PATHS.verificationReceipt,
      serializeJson(receipt)
    );
    const passed = GenerationSessionSchema.parse({
      ...running,
      revision: running.revision + 1,
      verification: {
        status: "passed",
        attemptId: running.verification.attemptId,
        reportPath: receipt.report.path,
        reportSha256: receipt.report.sha256,
        runId: receipt.report.runId
      }
    });
    try {
      await this.dependencies.store.completeVerification(
        running.id,
        running.revision,
        passed
      );
    } catch (error) {
      const latest = GenerationSessionSchema.parse(
        await this.dependencies.store.read(running.id)
      );
      if (!sameSession(latest, passed)) {
        throw error;
      }
    }
    return passed;
  }

  private async reconcilePassedVerification(
    running: GenerationSession,
    expected: ExpectedVerification,
    revalidateCurrent: () => Promise<void>
  ): Promise<{ session: GenerationSession; report: TapHoundReport } | undefined> {
    if (running.verification.status !== "running") {
      return undefined;
    }
    let receiptBytes: Buffer;
    try {
      receiptBytes = await this.dependencies.store.readEvidence(
        running.id,
        GENERATION_BUNDLE_PATHS.verificationReceipt
      );
    } catch (error) {
      if (
        error instanceof GenerationSessionStoreError
        && error.code === "EVIDENCE_NOT_FOUND"
      ) {
        return undefined;
      }
      throw failure(
        "VERIFICATION_FAILED",
        "verification",
        "Immutable verification receipt cannot be safely read",
        false,
        error
      );
    }
    let receipt: VerificationReceipt;
    let reportBytes: Buffer;
    try {
      receipt = VerificationReceiptSchema.parse(
        JSON.parse(receiptBytes.toString("utf8")) as unknown
      );
      reportBytes = await this.dependencies.store.readEvidence(
        running.id,
        receipt.report.path
      );
    } catch (error) {
      throw failure(
        "VERIFICATION_FAILED",
        "verification",
        "Immutable verification receipt or report is invalid",
        false,
        error
      );
    }
    if (
      !this.receiptMatches(receipt, expected)
      || sha256(reportBytes) !== receipt.report.sha256
    ) {
      throw failure(
        "VERIFICATION_FAILED",
        "verification",
        "Immutable verification receipt does not match this generation"
      );
    }
    let report: TapHoundReport;
    try {
      report = TapHoundReportSchema.parse(
        JSON.parse(reportBytes.toString("utf8")) as unknown
      );
      if (report.runId !== receipt.report.runId) {
        throw new Error("Verification Report run ID does not match receipt");
      }
      this.assertReport(
        report,
        {
          version: 1,
          name: expected.journey.name,
          steps: running.candidateSteps
        },
        expected,
        "VERIFICATION_FAILED"
      );
    } catch (error) {
      throw error instanceof GenerationFinalizationError
        ? error
        : failure(
            "VERIFICATION_FAILED",
            "verification",
            "Immutable verification Report does not match the receipt",
            false,
            error
          );
    }
    await revalidateCurrent();
    return {
      session: await this.persistPassedVerification(running, report, expected),
      report
    };
  }

  private async persistFailedVerification(
    running: GenerationSession,
    error: unknown
  ): Promise<void> {
    const latest = GenerationSessionSchema.parse(
      await this.dependencies.store.read(running.id)
    );
    if (
      running.verification.status !== "running"
      || latest.verification.status !== "running"
      || latest.revision !== running.revision
      || latest.verification.attemptId !== running.verification.attemptId
    ) {
      return;
    }
    const failed = GenerationSessionSchema.parse({
      ...latest,
      revision: latest.revision + 1,
      verification: {
        status: "failed",
        failure: {
          code: error instanceof GenerationFinalizationError
            ? error.code
            : "VERIFICATION_FAILED",
          message: error instanceof Error
            ? error.message
            : "Generation verification failed"
        }
      }
    });
    try {
      await this.dependencies.store.failVerification(
        latest.id,
        latest.revision,
        failed
      );
    } catch {
      const reconciled = GenerationSessionSchema.parse(
        await this.dependencies.store.read(latest.id)
      );
      if (!sameSession(reconciled, failed)) {
        throw failure(
          "RECOVERY_REQUIRED",
          "verification",
          "Unable to durably record verification failure"
        );
      }
    }
  }

  private async readVerifiedReport(
    session: GenerationSession,
    expected: ExpectedVerification
  ): Promise<TapHoundReport> {
    if (
      session.verification.status !== "passed"
    ) {
      throw failure(
        "RECOVERY_REQUIRED",
        "verification",
        "Passed verification state lacks immutable report evidence"
      );
    }
    let receipt: VerificationReceipt;
    let bytes: Buffer;
    try {
      receipt = VerificationReceiptSchema.parse(JSON.parse(
        (await this.dependencies.store.readEvidence(
          session.id,
          GENERATION_BUNDLE_PATHS.verificationReceipt
        )).toString("utf8")
      ) as unknown);
      bytes = await this.dependencies.store.readEvidence(
        session.id,
        receipt.report.path
      );
    } catch (error) {
      throw failure(
        "RECOVERY_REQUIRED",
        "verification",
        "Passed verification state lacks a valid immutable receipt",
        false,
        error
      );
    }
    if (
      !this.receiptMatches(receipt, expected)
      || receipt.report.path !== session.verification.reportPath
      || receipt.report.sha256 !== session.verification.reportSha256
      || receipt.report.runId !== session.verification.runId
      || sha256(bytes) !== receipt.report.sha256
    ) {
      throw failure(
        "RECOVERY_REQUIRED",
        "verification",
        "Immutable verification receipt does not match durable state"
      );
    }
    const report = TapHoundReportSchema.parse(
      JSON.parse(bytes.toString("utf8")) as unknown
    );
    if (
      report.runId !== receipt.report.runId
    ) {
      throw failure(
        "RECOVERY_REQUIRED",
        "verification",
        "Immutable verification report is not a clean passed replay"
      );
    }
    this.assertReport(
      report,
      {
        version: 1,
        name: expected.journey.name,
        steps: session.candidateSteps
      },
      expected,
      "RECOVERY_REQUIRED"
    );
    return report;
  }

  private buildMeta(
    session: GenerationSession,
    outputPath: string,
    report: TapHoundReport
  ): GenerationMeta {
    if (
      session.verification.status !== "passed"
    ) {
      throw failure(
        "RECOVERY_REQUIRED",
        "verification",
        "Generation verification is not durably passed"
      );
    }
    return GenerationMetaSchema.parse({
      version: 1,
      status: "verified",
      generationId: session.id,
      journeyPath: outputPath,
      bindings: {
        projectHash: session.bindings.projectHash,
        configHash: session.bindings.configHash,
        contextHash: session.bindings.contextHash
      },
      verification: {
        reportPath: GENERATION_BUNDLE_PATHS.verificationReport,
        reportSha256: session.verification.reportSha256,
        runId: report.runId,
        runs: 1
      },
      manualOverrideStepIndexes: session.candidateSources.flatMap(
        (source, index) => source === "manualOverride" ? [index] : []
      )
    });
  }

  private async ensureVerificationEvidence(
    generationId: string,
    path: string,
    expected: string
  ): Promise<void> {
    try {
      await this.dependencies.store.writeTextEvidence(
        generationId,
        path,
        expected
      );
    } catch {
      const existing = await this.dependencies.store.readEvidence(
        generationId,
        path
      );
      if (!existing.equals(Buffer.from(expected))) {
        throw failure(
          "RECOVERY_REQUIRED",
          "verification",
          `Immutable verification evidence conflicts at ${path}`
        );
      }
    }
  }
}
