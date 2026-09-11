import {
  GenerationMetaSchema,
  type GenerationMeta
} from "../../domain/generation.js";
import { ResolvedJourneyPathSchema } from "../../domain/journey-composition.js";
import { JourneySchema } from "../../domain/journey.js";
import type {
  JourneyCompositionStore
} from "../../ports/journey-composition-store.js";

export type JourneyRetireErrorCode =
  | "JOURNEY_NOT_FOUND"
  | "JOURNEY_INVALID"
  | "META_MISSING"
  | "META_INVALID"
  | "JOURNEY_ALREADY_RETIRED";

export class JourneyRetireError extends Error {
  public override readonly name = "JourneyRetireError";

  public constructor(
    public readonly code: JourneyRetireErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export interface JourneyRetireResult {
  status: "retired";
  journeyPath: string;
  metaPath: string;
  retiredAt: string;
}

function parseJson(bytes: Buffer): unknown {
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export class JourneyRetirer {
  public constructor(private readonly dependencies: {
    store: Pick<JourneyCompositionStore, "read" | "readJourneyMeta" | "writeText">;
  }) {}

  public readonly retire = async (input: {
    projectRoot: string;
    workspaceRoot?: string | undefined;
    journeyPath: string;
    reason: string;
    now: Date;
  }): Promise<JourneyRetireResult> => {
    const journeyPath = ResolvedJourneyPathSchema.parse(input.journeyPath);
    const metaPath = `${journeyPath.slice(0, -".json".length)}.meta.json`;

    let journeyBytes: Buffer;
    try {
      journeyBytes = await this.dependencies.store.read({
        projectRoot: input.projectRoot,
        relativePath: journeyPath,
        ...(input.workspaceRoot === undefined
          ? {}
          : { workspaceRoot: input.workspaceRoot })
      });
    } catch {
      throw new JourneyRetireError(
        "JOURNEY_NOT_FOUND",
        `Journey is not readable: ${journeyPath}`
      );
    }
    try {
      JourneySchema.parse(parseJson(journeyBytes));
    } catch (error) {
      throw new JourneyRetireError(
        "JOURNEY_INVALID",
        `Journey does not match the Journey schema: ${journeyPath}`,
        { cause: error }
      );
    }

    const metaBytes = await this.dependencies.store.readJourneyMeta({
      projectRoot: input.projectRoot,
      journeyPath,
      ...(input.workspaceRoot === undefined
        ? {}
        : { workspaceRoot: input.workspaceRoot })
    });
    if (metaBytes === null) {
      throw new JourneyRetireError(
        "META_MISSING",
        `Journey has no generation meta sidecar: ${metaPath}`
      );
    }
    let meta: GenerationMeta;
    try {
      meta = GenerationMetaSchema.parse(parseJson(metaBytes));
    } catch (error) {
      throw new JourneyRetireError(
        "META_INVALID",
        `Journey meta sidecar is invalid: ${metaPath}`,
        { cause: error }
      );
    }
    if (meta.retired !== undefined) {
      throw new JourneyRetireError(
        "JOURNEY_ALREADY_RETIRED",
        `Journey is already retired: ${journeyPath}`
      );
    }

    const retiredAt = input.now.toISOString();
    const updated: GenerationMeta = {
      ...meta,
      retired: {
        retiredAt,
        reason: input.reason.trim()
      }
    };
    await this.dependencies.store.writeText({
      projectRoot: input.projectRoot,
      relativePath: metaPath,
      content: serialize(updated),
      ...(input.workspaceRoot === undefined
        ? {}
        : { workspaceRoot: input.workspaceRoot })
    });
    const written = await this.dependencies.store.readJourneyMeta({
      projectRoot: input.projectRoot,
      journeyPath,
      ...(input.workspaceRoot === undefined
        ? {}
        : { workspaceRoot: input.workspaceRoot })
    });
    if (written === null) {
      throw new JourneyRetireError(
        "META_INVALID",
        `Retired meta sidecar is not readable: ${metaPath}`
      );
    }
    GenerationMetaSchema.parse(parseJson(written));
    return {
      status: "retired",
      journeyPath,
      metaPath,
      retiredAt
    };
  };
}