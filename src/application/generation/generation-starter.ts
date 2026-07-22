import { createHash } from "node:crypto";

import type {
  ContextValidator
} from "../context/context-validator.js";
import type {
  ProjectDescription
} from "../project/project-describer.js";
import {
  GenerationSessionSchema,
  type GenerationErrorCode,
  type GenerationSession
} from "../../domain/generation.js";
import {
  ProjectContextSchema,
  type ProjectContext
} from "../../domain/project-context.js";
import {
  TapHoundConfigSchema,
  type TapHoundConfig
} from "../../domain/config.js";
import type {
  GenerationSessionStore
} from "../../ports/generation-session-store.js";

export class GenerationOperationError extends Error {
  public override readonly name = "GenerationOperationError";

  public constructor(
    public readonly code: GenerationErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface GenerationStartInput {
  projectRoot: string;
  config: TapHoundConfig;
  context: ProjectContext;
  project: ProjectDescription;
  deviceSerial: string;
}

export interface GenerationStarterDependencies {
  contextValidator: Pick<ContextValidator, "validate">;
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

function hashCanonicalJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function randomHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
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
    const validation = await this.dependencies.contextValidator.validate({
      context: input.context,
      projectRoot: input.projectRoot,
      config
    });
    if (validation.status !== "valid") {
      throw new GenerationOperationError(
        validation.status === "stale" ? "CONTEXT_STALE" : "CONTEXT_INVALID",
        validation.reason.message
      );
    }
    const context = ProjectContextSchema.parse(input.context);
    if (
      input.project.projectRoot !== input.projectRoot
      || input.project.packageName !== config.run.packageName
      || context.packageName !== input.project.packageName
    ) {
      throw new GenerationOperationError(
        "CONTEXT_INVALID",
        "Project, config, and Context identity do not match"
      );
    }

    const generationId = this.dependencies.generateId();
    const runId = distinctId(generationId, this.dependencies.generateId);
    const session = GenerationSessionSchema.parse({
      version: 1,
      id: generationId,
      revision: 0,
      state: "active",
      bindings: {
        projectHash: hashCanonicalJson(input.project),
        configHash: hashCanonicalJson(config),
        contextHash: hashCanonicalJson(context),
        snapshotHash: null
      },
      target: {
        packageName: config.run.packageName,
        deviceSerial: input.deviceSerial,
        resetStrategy: "processOnly",
        interactionPolicy: context.interactionPolicy
      },
      variables: {
        runId,
        timestamp: this.dependencies.now().toISOString(),
        randomHex: randomHex(this.dependencies.randomBytes(16))
      },
      candidateSteps: [],
      inFlight: null,
      pendingConfirmation: null,
      verification: { status: "notRun" },
      publication: { status: "notRun" }
    });

    await this.dependencies.store.create(session);
    return session;
  };
}
