import { createHash } from "node:crypto";

import {
  GenerationMetaSchema,
  type GenerationMeta
} from "../../domain/generation.js";
import { ResolvedJourneyPathSchema } from "../../domain/journey-composition.js";
import { JourneySchema } from "../../domain/journey.js";
import { TapHoundReportSchema } from "../../domain/report.js";
import type {
  JourneyCompositionStore
} from "../../ports/journey-composition-store.js";
import {
  GENERATIONS_DIR
} from "../../domain/workspace.js";

export type JourneyPromotionErrorCode =
  | "JOURNEY_NOT_FOUND"
  | "JOURNEY_INVALID"
  | "META_MISSING"
  | "META_INVALID"
  | "JOURNEY_ALREADY_PROMOTED"
  | "EVIDENCE_MISSING"
  | "EVIDENCE_HASH_MISMATCH"
  | "JOURNEY_MODIFIED";

export class JourneyPromotionError extends Error {
  public override readonly name = "JourneyPromotionError";

  public constructor(
    public readonly code: JourneyPromotionErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export interface JourneyPromotionResult {
  status: "promoted";
  journeyPath: string;
  metaPath: string;
  generationId: string;
  promotedAt: string;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJson(bytes: Buffer): unknown {
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

function sameJson(left: Buffer, right: Buffer): boolean {
  return (
    JSON.stringify(parseJson(left)) === JSON.stringify(parseJson(right))
  );
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const VERIFIED_JOURNEY_EVIDENCE = "verified/journey.json";

export class JourneyPromoter {
  public constructor(private readonly dependencies: {
    store: Pick<JourneyCompositionStore, "read" | "readJourneyMeta" | "writeText">;
  }) {}

  public readonly promote = async (input: {
    projectRoot: string;
    journeyPath: string;
    reason: string;
    now: Date;
  }): Promise<JourneyPromotionResult> => {
    const journeyPath = ResolvedJourneyPathSchema.parse(input.journeyPath);
    const metaPath = `${journeyPath.slice(0, -".json".length)}.meta.json`;

    let journeyBytes: Buffer;
    try {
      journeyBytes = await this.dependencies.store.read({
        projectRoot: input.projectRoot,
        relativePath: journeyPath
      });
    } catch {
      throw new JourneyPromotionError(
        "JOURNEY_NOT_FOUND",
        `Journey is not readable: ${journeyPath}`
      );
    }
    try {
      JourneySchema.parse(parseJson(journeyBytes));
    } catch (error) {
      throw new JourneyPromotionError(
        "JOURNEY_INVALID",
        `Journey does not match the Journey schema: ${journeyPath}`,
        { cause: error }
      );
    }

    const metaBytes = await this.dependencies.store.readJourneyMeta({
      projectRoot: input.projectRoot,
      journeyPath
    });
    if (metaBytes === null) {
      throw new JourneyPromotionError(
        "META_MISSING",
        `Journey has no generation meta sidecar: ${metaPath}`
      );
    }
    let meta: GenerationMeta;
    try {
      meta = GenerationMetaSchema.parse(parseJson(metaBytes));
    } catch (error) {
      throw new JourneyPromotionError(
        "META_INVALID",
        `Journey meta sidecar is invalid: ${metaPath}`,
        { cause: error }
      );
    }
    if (meta.status === "promoted") {
      throw new JourneyPromotionError(
        "JOURNEY_ALREADY_PROMOTED",
        `Journey is already promoted: ${journeyPath}`
      );
    }

    const bundleRoot = `${GENERATIONS_DIR}/${meta.generationId}`;
    const reportPath = `${bundleRoot}/${meta.verification.reportPath}`;
    let reportBytes: Buffer;
    try {
      reportBytes = await this.dependencies.store.read({
        projectRoot: input.projectRoot,
        relativePath: reportPath
      });
    } catch {
      throw new JourneyPromotionError(
        "EVIDENCE_MISSING",
        `Verification evidence is missing: ${reportPath}`
      );
    }
    if (sha256(reportBytes) !== meta.verification.reportSha256) {
      throw new JourneyPromotionError(
        "EVIDENCE_HASH_MISMATCH",
        `Verification evidence no longer matches the promoted hash: ${reportPath}`
      );
    }
    const report = TapHoundReportSchema.parse(parseJson(reportBytes));
    if (report.runId !== meta.verification.runId) {
      throw new JourneyPromotionError(
        "EVIDENCE_HASH_MISMATCH",
        "Verification evidence run does not match the generation meta"
      );
    }

    let verifiedJourneyBytes: Buffer;
    try {
      verifiedJourneyBytes = await this.dependencies.store.read({
        projectRoot: input.projectRoot,
        relativePath: `${bundleRoot}/${VERIFIED_JOURNEY_EVIDENCE}`
      });
    } catch {
      throw new JourneyPromotionError(
        "EVIDENCE_MISSING",
        `Verified Journey evidence is missing: ${bundleRoot}`
      );
    }
    if (!sameJson(journeyBytes, verifiedJourneyBytes)) {
      throw new JourneyPromotionError(
        "JOURNEY_MODIFIED",
        `Journey no longer matches its verified evidence: ${journeyPath}`
      );
    }

    const promotedAt = input.now.toISOString();
    const promoted = GenerationMetaSchema.parse({
      ...meta,
      status: "promoted",
      promotion: {
        promotedAt,
        reason: input.reason
      }
    });
    await this.dependencies.store.writeText({
      projectRoot: input.projectRoot,
      relativePath: metaPath,
      content: serialize(promoted)
    });
    return {
      status: "promoted",
      journeyPath,
      metaPath,
      generationId: meta.generationId,
      promotedAt
    };
  };
}
