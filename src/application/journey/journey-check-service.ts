import type { TapHoundConfig } from "../../domain/config.js";
import {
  GenerationMetaSchema,
  type GenerationMeta
} from "../../domain/generation.js";
import { JourneySchema } from "../../domain/journey.js";
import type {
  ContextModuleReference,
  ProjectContext
} from "../../domain/project-context.js";
import { JOURNEYS_DIR } from "../../domain/workspace.js";
import type {
  JourneyCompositionStore
} from "../../ports/journey-composition-store.js";
import { hashGenerationBinding } from "../generation/generation-starter.js";
import type {
  ProjectDescription
} from "../project/project-describer.js";

export type JourneyCheckStatus = "fresh" | "stale" | "no-meta" | "invalid";

export type JourneyCheckReason =
  | "journey-unreadable"
  | "journey-schema"
  | "meta-unreadable"
  | "meta-schema"
  | "journey-path-mismatch"
  | "project-hash"
  | "config-hash"
  | "meta-legacy"
  | "module-drift"
  | "module-missing";

export interface JourneyCheckDriftedModule {
  id: string;
  reason: "sha256" | "missing";
}

export interface JourneyCheckEntry {
  name: string;
  journeyPath: string;
  metaPath: string;
  status: JourneyCheckStatus;
  reasons: readonly JourneyCheckReason[];
  driftedModules: readonly JourneyCheckDriftedModule[];
  message: string | undefined;
}

export interface JourneyCheckSummary {
  total: number;
  fresh: number;
  stale: number;
  noMeta: number;
  invalid: number;
}

export interface JourneyCheckResult {
  entries: readonly JourneyCheckEntry[];
  summary: JourneyCheckSummary;
}

export type JourneyCheckErrorCode = "CONFIG_INVALID";

export class JourneyCheckError extends Error {
  public override readonly name = "JourneyCheckError";

  public constructor(
    public readonly code: JourneyCheckErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export interface JourneyCheckInput {
  projectRoot: string;
  config: TapHoundConfig;
  project: ProjectDescription;
  bundle: ProjectContext;
}

export interface JourneyCheckDependencies {
  store: Pick<
    JourneyCompositionStore,
    "read" | "listJourneyPaths" | "readJourneyMeta"
  >;
}

function metaPathFor(journeyPath: string): string {
  return `${journeyPath.slice(0, -".json".length)}.meta.json`;
}

function journeyName(journeyPath: string): string {
  const prefix = `${JOURNEYS_DIR}/`;
  const withoutPrefix = journeyPath.startsWith(prefix)
    ? journeyPath.slice(prefix.length)
    : journeyPath;
  return withoutPrefix.slice(0, -".json".length);
}

function summarize(
  entries: readonly JourneyCheckEntry[]
): JourneyCheckSummary {
  const summary: JourneyCheckSummary = {
    total: entries.length,
    fresh: 0,
    stale: 0,
    noMeta: 0,
    invalid: 0
  };
  for (const entry of entries) {
    if (entry.status === "fresh") {
      summary.fresh += 1;
    } else if (entry.status === "stale") {
      summary.stale += 1;
    } else if (entry.status === "no-meta") {
      summary.noMeta += 1;
    } else {
      summary.invalid += 1;
    }
  }
  return summary;
}

function parseJson(bytes: Buffer): unknown {
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

export class JourneyCheckService {
  public constructor(private readonly dependencies: JourneyCheckDependencies) {}

  public readonly check = async (
    input: JourneyCheckInput
  ): Promise<JourneyCheckResult> => {
    const paths = await this.dependencies.store.listJourneyPaths(
      input.projectRoot
    );
    const projectHash = hashGenerationBinding(input.project);
    const configHash = hashGenerationBinding(input.config);
    const modulesById = new Map(
      input.bundle.modules.map((module) => [module.id, module])
    );
    const entries: JourneyCheckEntry[] = [];
    for (const journeyPath of paths) {
      entries.push(await this.checkJourney({
        projectRoot: input.projectRoot,
        journeyPath,
        projectHash,
        configHash,
        modulesById
      }));
    }
    return { entries, summary: summarize(entries) };
  };

  private readonly checkJourney = async (input: {
    projectRoot: string;
    journeyPath: string;
    projectHash: string;
    configHash: string;
    modulesById: Map<string, ContextModuleReference>;
  }): Promise<JourneyCheckEntry> => {
    const entry = (
      status: JourneyCheckStatus,
      reasons: readonly JourneyCheckReason[],
      message: string | undefined
    ): JourneyCheckEntry => ({
      name: journeyName(input.journeyPath),
      journeyPath: input.journeyPath,
      metaPath: metaPathFor(input.journeyPath),
      status,
      reasons,
      driftedModules: [],
      message
    });

    let bytes: Buffer;
    try {
      bytes = await this.dependencies.store.read({
        projectRoot: input.projectRoot,
        relativePath: input.journeyPath
      });
    } catch (error) {
      return entry(
        "invalid",
        ["journey-unreadable"],
        error instanceof Error ? error.message : String(error)
      );
    }
    try {
      JourneySchema.parse(parseJson(bytes));
    } catch (error) {
      return entry(
        "invalid",
        ["journey-schema"],
        error instanceof Error ? error.message : String(error)
      );
    }

    let metaBytes: Buffer | null;
    try {
      metaBytes = await this.dependencies.store.readJourneyMeta({
        projectRoot: input.projectRoot,
        journeyPath: input.journeyPath
      });
    } catch (error) {
      return entry(
        "invalid",
        ["meta-unreadable"],
        error instanceof Error ? error.message : String(error)
      );
    }
    if (metaBytes === null) {
      return entry("no-meta", [], undefined);
    }
    let meta: GenerationMeta;
    try {
      meta = GenerationMetaSchema.parse(parseJson(metaBytes));
    } catch (error) {
      return entry(
        "invalid",
        ["meta-schema"],
        error instanceof Error ? error.message : String(error)
      );
    }

    const reasons: JourneyCheckReason[] = [];
    const driftedModules: JourneyCheckDriftedModule[] = [];
    if (meta.journeyPath !== input.journeyPath) {
      reasons.push("journey-path-mismatch");
    }
    if (meta.bindings.projectHash !== input.projectHash) {
      reasons.push("project-hash");
    }
    if (meta.bindings.configHash !== input.configHash) {
      reasons.push("config-hash");
    }
    if (meta.contextSelection === undefined) {
      reasons.push("meta-legacy");
    } else {
      for (const module of meta.contextSelection.modules) {
        const reference = input.modulesById.get(module.id);
        if (reference === undefined) {
          driftedModules.push({ id: module.id, reason: "missing" });
        } else if (reference.sha256 !== module.sha256) {
          driftedModules.push({ id: module.id, reason: "sha256" });
        }
      }
      if (driftedModules.some((module) => module.reason === "sha256")) {
        reasons.push("module-drift");
      }
      if (driftedModules.some((module) => module.reason === "missing")) {
        reasons.push("module-missing");
      }
    }
    return {
      name: journeyName(input.journeyPath),
      journeyPath: input.journeyPath,
      metaPath: metaPathFor(input.journeyPath),
      status: reasons.length === 0 ? "fresh" : "stale",
      reasons,
      driftedModules,
      message: undefined
    };
  };
}
