import { createHash } from "node:crypto";
import { extname, resolve } from "node:path";

import {
  GenerationBundleManifestSchema,
  GenerationMetaSchema,
  GenerationReportSchema,
  type GenerationBundleManifest,
  type GenerationMeta,
  type GenerationReport
} from "../../domain/generation.js";
import { JourneySchema, type Journey } from "../../domain/journey.js";
import {
  TapHoundReportSchema,
  type TapHoundReport
} from "../../domain/report.js";
import type {
  ProjectBoundGenerationMetaWriterPort
} from "../../ports/generation-meta-writer.js";
import {
  GenerationSessionStoreError,
  type GenerationSessionStore
} from "../../ports/generation-session-store.js";
import type {
  ProjectBoundJourneyWriterPort
} from "../../ports/journey-writer.js";

export const GENERATION_BUNDLE_PATHS = {
  candidateJourney: "candidate/journey.json",
  verifiedJourney: "verified/journey.json",
  generationReport: "generation-report.json",
  verificationReport: "verification/report.json",
  verificationReceipt: "verification/receipt.json",
  meta: "meta.json",
  manifest: "manifest.json"
} as const;

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifestEntry(path: string, bytes: string | Buffer): {
  path: string;
  bytes: number;
  sha256: string;
} {
  return {
    path,
    bytes: Buffer.byteLength(bytes),
    sha256: sha256(bytes)
  };
}

async function ensureEvidence(
  store: Pick<
    GenerationSessionStore,
    "writeTextEvidence" | "readEvidence"
  >,
  generationId: string,
  path: string,
  expected: string
): Promise<void> {
  try {
    await store.writeTextEvidence(generationId, path, expected);
  } catch (error) {
    if (
      !(error instanceof GenerationSessionStoreError)
      || error.code !== "EVIDENCE_ALREADY_EXISTS"
    ) {
      throw error;
    }
  }
  const stored = await store.readEvidence(generationId, path);
  if (!stored.equals(Buffer.from(expected))) {
    throw new GenerationSessionStoreError(
      "INVALID_EVIDENCE",
      `Immutable evidence does not match expected bytes: ${path}`
    );
  }
}

export function generationMetaOutputPath(journeyOutputPath: string): string {
  const extension = extname(journeyOutputPath);
  return extension.toLowerCase() === ".json"
    ? `${journeyOutputPath.slice(0, -extension.length)}.meta.json`
    : `${journeyOutputPath}.meta.json`;
}

export interface GenerationBundleContent {
  generationId: string;
  journey: Journey;
  report: GenerationReport;
  verificationReport: TapHoundReport;
  meta: GenerationMeta;
}

export interface GenerationPublisherDependencies {
  store: Pick<
    GenerationSessionStore,
    "writeTextEvidence" | "readEvidence" | "listEvidence" | "publish"
  >;
  journeyWriter: ProjectBoundJourneyWriterPort;
  metaWriter: ProjectBoundGenerationMetaWriterPort;
}

export class GenerationPublisher {
  public constructor(
    private readonly dependencies: GenerationPublisherDependencies
  ) {}

  public readonly stage = async (
    input: GenerationBundleContent
  ): Promise<GenerationBundleManifest> => {
    const journey = JourneySchema.parse(input.journey);
    const report = GenerationReportSchema.parse(input.report);
    const verificationReport = TapHoundReportSchema.parse(
      input.verificationReport
    );
    const meta = GenerationMetaSchema.parse(input.meta);
    if (
      input.generationId !== report.generationId
      || input.generationId !== meta.generationId
      || report.steps.length !== journey.steps.length
    ) {
      throw new Error("Generation bundle identities do not align");
    }

    const journeyBytes = serializeJson(journey);
    const receiptBytes = (
      await this.dependencies.store.readEvidence(
        input.generationId,
        GENERATION_BUNDLE_PATHS.verificationReceipt
      )
    ).toString("utf8");
    const files = [
      [GENERATION_BUNDLE_PATHS.candidateJourney, journeyBytes],
      [GENERATION_BUNDLE_PATHS.verifiedJourney, journeyBytes],
      [GENERATION_BUNDLE_PATHS.generationReport, serializeJson(report)],
      [
        GENERATION_BUNDLE_PATHS.verificationReport,
        serializeJson(verificationReport)
      ],
      [GENERATION_BUNDLE_PATHS.verificationReceipt, receiptBytes],
      [GENERATION_BUNDLE_PATHS.meta, serializeJson(meta)]
    ] as const;
    for (const [path, bytes] of files) {
      await ensureEvidence(
        this.dependencies.store,
        input.generationId,
        path,
        bytes
      );
    }

    const evidenceFiles = await this.dependencies.store.listEvidence(
      input.generationId
    );
    const manifest = GenerationBundleManifestSchema.parse({
      version: 1,
      generationId: input.generationId,
      files: evidenceFiles.map((file) => manifestEntry(
        file.path,
        Buffer.from(file.contentBase64, "base64")
      ))
    });
    await ensureEvidence(
      this.dependencies.store,
      input.generationId,
      GENERATION_BUNDLE_PATHS.manifest,
      serializeJson(manifest)
    );
    await this.verifyManifest(input.generationId, manifest);
    return manifest;
  };

  public readonly publish = async (generationId: string): Promise<string> => {
    await this.verifyPublishedManifest(generationId);
    const bundlePath = await this.dependencies.store.publish(generationId);
    await this.verifyPublishedManifest(generationId);
    return bundlePath;
  };

  public readonly export = async (input: {
    generationId: string;
    projectRoot: string;
    journeyPath: string;
    journey: Journey;
    meta: GenerationMeta;
  }): Promise<{ journeyPath: string; metaPath: string }> => {
    const journey = JourneySchema.parse(input.journey);
    const meta = GenerationMetaSchema.parse(input.meta);
    const journeyPath = resolve(input.projectRoot, input.journeyPath);
    const metaPath = generationMetaOutputPath(journeyPath);
    const authorityRoot = resolve(input.projectRoot, ".taphound");
    try {
      await this.dependencies.journeyWriter.writeProjectBound({
        projectRoot: input.projectRoot,
        authorityRoot,
        outputPath: journeyPath,
        journey
      });
      const expectedJourney = Buffer.from(serializeJson(journey));
      const actualJourney = await this.dependencies.journeyWriter
        .readProjectBound({
          projectRoot: input.projectRoot,
          authorityRoot,
          outputPath: journeyPath
        });
      if (!actualJourney.equals(expectedJourney)) {
        throw new Error("Exported Journey bytes do not match verified evidence");
      }
      await this.verifyPublishedManifest(input.generationId);
    } catch (error) {
      await this.verifyPublishedManifest(input.generationId);
      throw error;
    }
    try {
      await this.dependencies.metaWriter.writeProjectBound({
        projectRoot: input.projectRoot,
        authorityRoot,
        outputPath: metaPath,
        meta
      });
      const expectedMeta = Buffer.from(serializeJson(meta));
      const actualMeta = await this.dependencies.metaWriter.readProjectBound({
        projectRoot: input.projectRoot,
        authorityRoot,
        outputPath: metaPath
      });
      if (!actualMeta.equals(expectedMeta)) {
        throw new Error("Exported generation meta bytes do not match evidence");
      }
      await this.verifyPublishedManifest(input.generationId);
    } catch (error) {
      await this.verifyPublishedManifest(input.generationId);
      throw error;
    }
    return { journeyPath, metaPath };
  };

  private readonly verifyPublishedManifest = async (
    generationId: string
  ): Promise<void> => {
    const manifest = GenerationBundleManifestSchema.parse(JSON.parse(
      (await this.dependencies.store.readEvidence(
        generationId,
        GENERATION_BUNDLE_PATHS.manifest
      )).toString("utf8")
    ) as unknown);
    if (manifest.generationId !== generationId) {
      throw new GenerationSessionStoreError(
        "INVALID_EVIDENCE",
        "Published manifest generation id does not match"
      );
    }
    await this.verifyManifest(generationId, manifest);
  };

  private readonly verifyManifest = async (
    generationId: string,
    manifest: GenerationBundleManifest
  ): Promise<void> => {
    GenerationBundleManifestSchema.parse(manifest);
    const evidenceFiles = await this.dependencies.store.listEvidence(
      generationId
    );
    const manifestPaths = manifest.files.map((file) => file.path);
    const evidencePaths = evidenceFiles.map((file) => file.path);
    if (JSON.stringify(manifestPaths) !== JSON.stringify(evidencePaths)) {
      throw new GenerationSessionStoreError(
        "INVALID_EVIDENCE",
        "Manifest does not exactly enumerate immutable generation evidence"
      );
    }
    for (const file of manifest.files) {
      const evidence = evidenceFiles.find(
        (candidate) => candidate.path === file.path
      );
      if (evidence === undefined) {
        throw new GenerationSessionStoreError(
          "INVALID_EVIDENCE",
          `Manifest content is missing: ${file.path}`
        );
      }
      const bytes = Buffer.from(evidence.contentBase64, "base64");
      if (
        bytes.byteLength !== evidence.byteLength
        || bytes.byteLength !== file.bytes
        || sha256(bytes) !== file.sha256
      ) {
        throw new GenerationSessionStoreError(
          "INVALID_EVIDENCE",
          `Manifest content verification failed: ${file.path}`
        );
      }
    }
  };
}
