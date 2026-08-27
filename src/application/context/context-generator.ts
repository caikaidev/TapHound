import { isAbsolute, resolve } from "node:path";

import {
  ProjectContextModuleSchema,
  ProjectContextSchema,
  type ContextManifest,
  type ContextModuleReference,
  type InteractionPolicy,
  type ProjectContext,
  type ProjectContextModule
} from "../../domain/project-context.js";
import { CONTEXT_DIR } from "../../domain/workspace.js";
import type {
  ProjectIdentityInspector
} from "../../ports/project-identity-inspector.js";
import type {
  ProjectModuleDiscoverer
} from "../../ports/project-module-discoverer.js";
import type {
  ContextDocumentWriter
} from "../../ports/context-document-writer.js";
import type {
  ProjectFileInspector
} from "../../ports/project-file-inspector.js";
import type {
  ProjectInventoryInspector
} from "../../ports/project-inventory-inspector.js";
import { projectRelativePath } from "../../shared/paths.js";
import { compareStrings } from "../../shared/strings.js";
import { MAX_CONTEXT_EVIDENCE_BYTES } from "./context-validator.js";
import { semanticSha256 } from "./evidence-hash.js";

export type ContextGenerateErrorCode =
  | "CONTEXT_INVALID"
  | "MODULE_DISCOVERY_FAILED"
  | "IDENTITY_INSPECTION_FAILED"
  | "NO_EVIDENCE"
  | "CONTEXT_WRITE_FAILED"
  | "CONTEXT_ALREADY_EXISTS";

export class ContextGenerateError extends Error {
  public override readonly name = "ContextGenerateError";

  public constructor(
    public readonly code: ContextGenerateErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface ContextGenerateInput {
  readonly projectRoot: string;
  readonly contextPath: string;
  readonly force?: boolean;
}

export interface ContextGenerateModuleResult {
  readonly id: string;
  readonly projectDir: string;
  readonly kind: string;
  readonly status: "notAnalyzed";
  readonly evidenceCount: number;
  readonly contextPath: string;
  readonly sha256: string;
}

export interface ContextGenerateResult {
  readonly status: "generated";
  readonly packageName: string;
  readonly launchActivity: string;
  readonly modules: readonly ContextGenerateModuleResult[];
  readonly indexHash: string;
  readonly contextPath: string;
}

export interface ContextGeneratorDependencies {
  readonly discoverer: ProjectModuleDiscoverer;
  readonly identity: ProjectIdentityInspector;
  readonly files: ProjectFileInspector;
  readonly inventory: ProjectInventoryInspector;
  readonly writer: ContextDocumentWriter;
}

interface EvidenceRecord {
  readonly path: string;
  readonly sha256: string;
  readonly semanticSha256: string;
}

const INVENTORY_CATEGORIES = ["manifests", "sources", "layouts", "navigation"] as const;

const DEFAULT_INTERACTION_POLICY: InteractionPolicy = {
  allowedActions: ["click", "inputText", "back", "wait"],
  confirmationRequiredActions: [],
  forbiddenActions: []
};

const ROOT_EVIDENCE_CANDIDATES = [
  "settings.gradle.kts",
  "settings.gradle",
  "build.gradle.kts",
  "build.gradle",
  "gradle.properties",
  "gradle/libs.versions.toml"
];

function moduleIdToContextPath(moduleId: string): string {
  const sanitized = moduleId.replace(/^:/, "").replace(/:/g, "-");
  return `${CONTEXT_DIR}/modules/${sanitized}.json`;
}

async function collectEvidence(
  files: ProjectFileInspector,
  projectRoot: string,
  paths: readonly string[]
): Promise<EvidenceRecord[]> {
  const evidence: EvidenceRecord[] = [];
  for (const path of paths) {
    const inspection = await files.inspectProjectFile({
      projectRoot,
      relativePath: path,
      maximumBytes: MAX_CONTEXT_EVIDENCE_BYTES
    });
    if (inspection.status === "inspected" && inspection.bytes !== undefined) {
      evidence.push({
        path: inspection.resolvedRelativePath,
        sha256: inspection.sha256,
        semanticSha256: semanticSha256(inspection.bytes)
      });
    }
  }
  return evidence;
}

async function collectRootEvidence(
  files: ProjectFileInspector,
  projectRoot: string
): Promise<EvidenceRecord[]> {
  return collectEvidence(files, projectRoot, ROOT_EVIDENCE_CANDIDATES);
}

function buildShardDocument(
  module: { readonly id: string; readonly projectDir: string; readonly kind: string },
  evidence: readonly EvidenceRecord[],
  pathSetSha256: string
): ProjectContextModule {
  const manifest: ContextManifest = {
    version: 1,
    files: evidence.map((record) => ({
      path: record.path,
      sha256: record.sha256,
      semanticSha256: record.semanticSha256,
      confidence: "sourceConfirmed" as const
    }))
  };
  return {
    version: 2,
    moduleId: module.id,
    projectDir: module.projectDir,
    status: "notAnalyzed",
    inventory: {
      version: 2,
      pathSetSha256,
      categories: [...INVENTORY_CATEGORIES]
    },
    manifest,
    summary: {
      features: [],
      activities: [],
      elements: [],
      transitions: [],
      logcat: []
    }
  };
}

function buildModuleReference(
  module: { readonly id: string; readonly projectDir: string; readonly kind: string },
  contextPath: string,
  sha256: string,
  dependsOn: readonly string[]
): ContextModuleReference {
  return {
    id: module.id,
    projectDir: module.projectDir,
    kind: module.kind as "application" | "feature" | "library",
    contextPath,
    sha256,
    features: [],
    activities: [],
    dependsOn: [...dependsOn],
    status: "notAnalyzed"
  };
}

async function writeDocument(
  writer: ContextDocumentWriter,
  projectRoot: string,
  relativePath: string,
  document: unknown
): Promise<string> {
  const result = await writer.writeContextDocument({
    projectRoot,
    relativePath,
    document
  });
  if (result.status !== "written") {
    throw new ContextGenerateError(
      "CONTEXT_WRITE_FAILED",
      result.status === "escape"
        ? `Context document resolves outside the project: ${relativePath}`
        : `Context document cannot be written: ${relativePath}${"message" in result ? `: ${result.message}` : ""}`
    );
  }
  return result.sha256;
}

export class ContextGenerator {
  public constructor(
    private readonly dependencies: ContextGeneratorDependencies
  ) {}

  public readonly generate = async (
    input: ContextGenerateInput
  ): Promise<ContextGenerateResult> => {
    const contextPath = isAbsolute(input.contextPath)
      ? input.contextPath
      : resolve(input.projectRoot, input.contextPath);

    const contextRelativePath = projectRelativePath(
      input.projectRoot,
      contextPath,
      (message) => new ContextGenerateError("CONTEXT_INVALID", message)
    );

    if (input.force !== true) {
      const existing = await this.dependencies.files.inspectProjectFile({
        projectRoot: input.projectRoot,
        relativePath: contextRelativePath,
        maximumBytes: 1
      });
      if (existing.status === "inspected") {
        throw new ContextGenerateError(
          "CONTEXT_ALREADY_EXISTS",
          `Project Context already exists: ${contextRelativePath} (use --force to overwrite)`
        );
      }
    }

    const discovery = await this.dependencies.discoverer.discoverModules({
      projectRoot: input.projectRoot
    });
    if (discovery.status !== "discovered") {
      throw new ContextGenerateError(
        "MODULE_DISCOVERY_FAILED",
        discovery.status === "noApplicationModule"
          ? "No application module found in settings.gradle"
          : discovery.status === "noSettingsFile"
            ? "No settings.gradle or settings.gradle.kts found"
            : `Module discovery failed: ${discovery.status}`
      );
    }

    const appModule = discovery.modules.find(
      (module) => module.kind === "application"
    );
    if (appModule === undefined) {
      throw new ContextGenerateError(
        "MODULE_DISCOVERY_FAILED",
        "No application module found"
      );
    }

    const identity = await this.dependencies.identity.inspectIdentity({
      projectRoot: input.projectRoot,
      moduleDir: appModule.projectDir
    });
    if (identity.status !== "inspected") {
      throw new ContextGenerateError(
        "IDENTITY_INSPECTION_FAILED",
        `Identity inspection failed: ${identity.status}`
      );
    }

    const moduleResults: ContextGenerateModuleResult[] = [];
    const moduleReferences: ContextModuleReference[] = [];

    for (const module of discovery.modules) {
      const inventoryResult = await this.dependencies.inventory.inspectProjectInventory({
        projectRoot: input.projectRoot,
        projectDir: module.projectDir,
        categories: [...INVENTORY_CATEGORIES]
      });
      if (inventoryResult.status !== "inspected") {
        throw new ContextGenerateError(
          "MODULE_DISCOVERY_FAILED",
          `Unable to inspect module inventory: ${module.id}`
        );
      }

      const evidence = await collectEvidence(
        this.dependencies.files,
        input.projectRoot,
        inventoryResult.paths
      );
      if (evidence.length === 0) {
        throw new ContextGenerateError(
          "NO_EVIDENCE",
          `No evidence files collected for module: ${module.id}`
        );
      }

      const shardPath = moduleIdToContextPath(module.id);
      const shardDocument = buildShardDocument(
        module,
        evidence,
        inventoryResult.pathSetSha256
      );

      const parsed = ProjectContextModuleSchema.safeParse(shardDocument);
      if (!parsed.success) {
        throw new ContextGenerateError(
          "CONTEXT_INVALID",
          `Generated shard does not match module schema: ${module.id}`
        );
      }

      const shardSha256 = await writeDocument(
        this.dependencies.writer,
        input.projectRoot,
        shardPath,
        parsed.data
      );

      moduleResults.push({
        id: module.id,
        projectDir: module.projectDir,
        kind: module.kind,
        status: "notAnalyzed",
        evidenceCount: evidence.length,
        contextPath: shardPath,
        sha256: shardSha256
      });

      moduleReferences.push(
        buildModuleReference(module, shardPath, shardSha256, module.dependsOn)
      );
    }

    moduleReferences.sort((a, b) => compareStrings(a.id, b.id));

    const rootEvidence = await collectRootEvidence(
      this.dependencies.files,
      input.projectRoot
    );
    if (rootEvidence.length === 0) {
      throw new ContextGenerateError(
        "NO_EVIDENCE",
        "No root evidence files collected"
      );
    }

    const indexDocument: ProjectContext = {
      version: 2,
      packageName: identity.packageName,
      launchActivity: identity.launchActivity,
      manifest: {
        version: 1,
        files: rootEvidence.map((record) => ({
          path: record.path,
          sha256: record.sha256,
          semanticSha256: record.semanticSha256,
          confidence: "sourceConfirmed" as const
        }))
      },
      interactionPolicy: { ...DEFAULT_INTERACTION_POLICY },
      modules: moduleReferences
    };

    const parsedIndex = ProjectContextSchema.safeParse(indexDocument);
    if (!parsedIndex.success) {
      throw new ContextGenerateError(
        "CONTEXT_INVALID",
        "Generated index does not match the version 2 schema"
      );
    }

    const indexHash = await writeDocument(
      this.dependencies.writer,
      input.projectRoot,
      contextRelativePath,
      parsedIndex.data
    );

    return {
      status: "generated",
      packageName: identity.packageName,
      launchActivity: identity.launchActivity,
      modules: moduleResults,
      indexHash,
      contextPath: contextRelativePath
    };
  };
}
