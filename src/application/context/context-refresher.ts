import {
  ProjectContextModuleSchema,
  ProjectContextSchema,
  type ContextManifest,
  type ContextModuleReference,
  type ProjectContext,
  type ProjectContextModule
} from "../../domain/project-context.js";
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
import { MAX_CONTEXT_SHARD_BYTES, type ContextLoader } from "./context-loader.js";
import { MAX_CONTEXT_EVIDENCE_BYTES } from "./context-validator.js";
import { semanticSha256 } from "./evidence-hash.js";
import { assertShardIdentity } from "./shard-identity.js";

export type ContextRefreshErrorCode =
  | "CONTEXT_INVALID"
  | "CONTEXT_MODULE_NOT_FOUND"
  | "CONTEXT_WRITE_FAILED";

export class ContextRefreshError extends Error {
  public override readonly name = "ContextRefreshError";

  public constructor(
    public readonly code: ContextRefreshErrorCode,
    message: string
  ) {
    super(message);
  }
}

export type ContextRefreshBlockCode =
  | "EVIDENCE_UNRESOLVED"
  | "EVIDENCE_SEMANTIC_CHANGED"
  | "MODULE_INVENTORY_CHANGED";

export type ContextRefreshResolution =
  | "pruneDeleted"
  | "acceptSourceChanges"
  | "reanalyze";

export interface ContextRefreshBlock {
  code: ContextRefreshBlockCode;
  resolution: ContextRefreshResolution;
  message: string;
}

export interface ContextRefreshScopeReport {
  scope: "index" | "module";
  id: string;
  contextPath: string;
  written: boolean;
  semanticBackfilled: number;
  formattingRehashed: number;
  semanticChanged: string[];
  unresolved: string[];
  pruned: number;
  inventoryChanged: boolean;
}

export interface ContextRefreshResult {
  status: "refreshed" | "unchanged" | "blocked";
  indexHash: string;
  acceptedSourceChanges: boolean;
  scopes: ContextRefreshScopeReport[];
  blocked: ContextRefreshBlock[];
}

export interface ContextRefreshInput {
  projectRoot: string;
  contextPath: string;
  moduleIds?: string[] | undefined;
  acceptSourceChanges?: boolean | undefined;
  pruneDeleted?: boolean | undefined;
}

export interface ContextRefresherDependencies {
  files: ProjectFileInspector;
  inventory: ProjectInventoryInspector;
  loader: Pick<ContextLoader, "readIndex">;
  writer: ContextDocumentWriter;
}

type ContextEvidence = ContextManifest["files"][number];

interface ManifestRefresh {
  files: ContextEvidence[];
  modified: boolean;
  semanticBackfilled: number;
  formattingRehashed: number;
  semanticChanged: string[];
  unresolved: string[];
  pruned: number;
}

interface ModuleRefresh {
  reference: ContextModuleReference;
  document: ProjectContextModule;
  currentSha256: string;
  modified: boolean;
  report: ContextRefreshScopeReport;
}

function selectedReferences(
  bundle: ProjectContext,
  moduleIds: string[] | undefined
): ContextModuleReference[] {
  if (moduleIds === undefined || moduleIds.length === 0) {
    return bundle.modules;
  }
  const requested = new Set(moduleIds);
  for (const id of requested) {
    if (!bundle.modules.some((module) => module.id === id)) {
      throw new ContextRefreshError(
        "CONTEXT_MODULE_NOT_FOUND",
        `Project Context module does not exist: ${id}`
      );
    }
  }
  return bundle.modules.filter((module) => requested.has(module.id));
}

function scopeBlocks(
  report: ContextRefreshScopeReport,
  acceptSourceChanges: boolean
): ContextRefreshBlock[] {
  const blocks: ContextRefreshBlock[] = [];
  if (report.unresolved.length > 0) {
    const allNotFound = report.unresolved.every(
      (entry) => entry.endsWith(": notFound")
    );
    blocks.push({
      code: "EVIDENCE_UNRESOLVED",
      resolution: allNotFound ? "pruneDeleted" : "reanalyze",
      message: `${report.id}: evidence cannot be hashed (${
        report.unresolved.join(", ")
      })`
    });
  }
  if (acceptSourceChanges) {
    return blocks;
  }
  if (report.semanticChanged.length > 0) {
    blocks.push({
      code: "EVIDENCE_SEMANTIC_CHANGED",
      resolution: "acceptSourceChanges",
      message: `${report.id}: ${
        String(report.semanticChanged.length)
      } evidence files changed semantically (${report.semanticChanged.join(", ")})`
    });
  }
  if (report.inventoryChanged) {
    blocks.push({
      code: "MODULE_INVENTORY_CHANGED",
      resolution: "acceptSourceChanges",
      message: `${report.id}: module file inventory changed`
    });
  }
  return blocks;
}

export class ContextRefresher {
  public constructor(
    private readonly dependencies: ContextRefresherDependencies
  ) {}

  public readonly refresh = async (
    input: ContextRefreshInput
  ): Promise<ContextRefreshResult> => {
    const indexPath = projectRelativePath(
      input.projectRoot,
      input.contextPath,
      (message) => new ContextRefreshError("CONTEXT_INVALID", message)
    );
    const { bundle, indexHash } = await this.dependencies.loader.readIndex({
      projectRoot: input.projectRoot,
      contextPath: input.contextPath
    });
    const acceptSourceChanges = input.acceptSourceChanges === true;
    const pruneDeleted = input.pruneDeleted === true;
    const references = selectedReferences(bundle, input.moduleIds);

    const root = await this.refreshManifest(
      input.projectRoot,
      bundle.manifest,
      acceptSourceChanges,
      pruneDeleted
    );
    const rootReport: ContextRefreshScopeReport = {
      scope: "index",
      id: "index",
      contextPath: indexPath,
      written: false,
      semanticBackfilled: root.semanticBackfilled,
      formattingRehashed: root.formattingRehashed,
      semanticChanged: root.semanticChanged,
      unresolved: root.unresolved,
      pruned: root.pruned,
      inventoryChanged: false
    };

    const modules: ModuleRefresh[] = [];
    for (const reference of references) {
      modules.push(await this.refreshModule(
        input.projectRoot,
        reference,
        acceptSourceChanges,
        pruneDeleted
      ));
    }

    const blocked = [
      ...scopeBlocks(rootReport, acceptSourceChanges),
      ...modules.flatMap(
        (module) => scopeBlocks(module.report, acceptSourceChanges)
      )
    ];
    const scopes = [rootReport, ...modules.map((module) => module.report)];
    if (blocked.length > 0) {
      return {
        status: "blocked",
        indexHash,
        acceptedSourceChanges: acceptSourceChanges,
        scopes,
        blocked
      };
    }

    const moduleHashes = new Map<string, string>();
    for (const module of modules) {
      if (!module.modified) {
        moduleHashes.set(module.reference.id, module.currentSha256);
      }
    }

    const modifiedModules = modules.filter((module) => module.modified);
    if (modifiedModules.length > 0) {
      const batchWriter = this.dependencies.writer.writeContextDocumentBatch;
      if (batchWriter !== undefined) {
        const results = await batchWriter({
          projectRoot: input.projectRoot,
          documents: modifiedModules.map((module) => ({
            relativePath: module.reference.contextPath,
            document: module.document
          }))
        });
        for (let i = 0; i < modifiedModules.length; i++) {
          const module = modifiedModules[i];
          if (module === undefined) {
            continue;
          }
          const result = results[i];
          if (result === undefined || result.status !== "written") {
            let message: string;
            if (result === undefined) {
              message = `Context document cannot be written: ${module.reference.contextPath}`;
            } else if (result.status === "escape") {
              message = `Context document resolves outside the project: ${module.reference.contextPath}`;
            } else {
              message = `Context document cannot be written: ${module.reference.contextPath} (${result.message})`;
            }
            throw new ContextRefreshError("CONTEXT_WRITE_FAILED", message);
          }
          moduleHashes.set(module.reference.id, result.sha256);
          module.report.written = true;
        }
      } else {
        for (const module of modifiedModules) {
          moduleHashes.set(
            module.reference.id,
            await this.writeDocument(
              input.projectRoot,
              module.reference.contextPath,
              module.document
            )
          );
          module.report.written = true;
        }
      }
    }

    const nextModules = bundle.modules.map((module) => {
      const sha256 = moduleHashes.get(module.id);
      return sha256 === undefined || sha256 === module.sha256
        ? module
        : { ...module, sha256 };
    });
    const indexModified = root.modified
      || nextModules.some((module, index) => module !== bundle.modules[index]);
    if (!indexModified) {
      return {
        status: modules.some((module) => module.report.written)
          ? "refreshed"
          : "unchanged",
        indexHash,
        acceptedSourceChanges: acceptSourceChanges,
        scopes,
        blocked
      };
    }

    const nextBundle = ProjectContextSchema.safeParse({
      ...bundle,
      manifest: { ...bundle.manifest, files: root.files },
      modules: nextModules
    });
    if (!nextBundle.success) {
      throw new ContextRefreshError(
        "CONTEXT_INVALID",
        "Refreshed Project Context index does not match the version 2 schema"
      );
    }
    const nextIndexHash = await this.writeDocument(
      input.projectRoot,
      indexPath,
      nextBundle.data
    );
    rootReport.written = true;

    return {
      status: "refreshed",
      indexHash: nextIndexHash,
      acceptedSourceChanges: acceptSourceChanges,
      scopes,
      blocked
    };
  };

  private readonly refreshModule = async (
    projectRoot: string,
    reference: ContextModuleReference,
    acceptSourceChanges: boolean,
    pruneDeleted: boolean
  ): Promise<ModuleRefresh> => {
    const shard = await this.readShard(projectRoot, reference);
    const manifest = await this.refreshManifest(
      projectRoot,
      shard.document.manifest,
      acceptSourceChanges,
      pruneDeleted
    );
    const inventory = await this.dependencies.inventory.inspectProjectInventory({
      projectRoot,
      projectDir: shard.document.projectDir,
      categories: shard.document.inventory.categories
    });
    if (inventory.status !== "inspected") {
      throw new ContextRefreshError(
        "CONTEXT_INVALID",
        `Unable to inspect module inventory: ${reference.id}`
      );
    }
    const inventoryChanged = (
      inventory.pathSetSha256 !== shard.document.inventory.pathSetSha256
    );
    const acceptedInventory = inventoryChanged && acceptSourceChanges;
    const document = ProjectContextModuleSchema.safeParse({
      ...shard.document,
      inventory: acceptedInventory
        ? {
            ...shard.document.inventory,
            pathSetSha256: inventory.pathSetSha256
          }
        : shard.document.inventory,
      manifest: { ...shard.document.manifest, files: manifest.files }
    });
    if (!document.success) {
      throw new ContextRefreshError(
        "CONTEXT_INVALID",
        `Refreshed Context shard does not match the module schema: ${
          reference.contextPath
        }`
      );
    }
    return {
      reference,
      document: document.data,
      currentSha256: shard.sha256,
      modified: manifest.modified || acceptedInventory,
      report: {
        scope: "module",
        id: reference.id,
        contextPath: reference.contextPath,
        written: false,
        semanticBackfilled: manifest.semanticBackfilled,
        formattingRehashed: manifest.formattingRehashed,
        semanticChanged: manifest.semanticChanged,
        unresolved: manifest.unresolved,
        pruned: manifest.pruned,
        inventoryChanged
      }
    };
  };

  private readonly refreshManifest = async (
    projectRoot: string,
    manifest: ContextManifest,
    acceptSourceChanges: boolean,
    pruneDeleted: boolean
  ): Promise<ManifestRefresh> => {
    const files: ContextEvidence[] = [];
    const semanticChanged: string[] = [];
    const unresolved: string[] = [];
    let modified = false;
    let semanticBackfilled = 0;
    let formattingRehashed = 0;
    let pruned = 0;

    for (const evidence of manifest.files) {
      const inspection = await this.dependencies.files.inspectProjectFile({
        projectRoot,
        relativePath: evidence.path,
        maximumBytes: MAX_CONTEXT_EVIDENCE_BYTES
      });
      if (inspection.status !== "inspected" || inspection.bytes === undefined) {
        if (pruneDeleted && inspection.status === "notFound") {
          pruned += 1;
          modified = true;
          continue;
        }
        unresolved.push(`${evidence.path}: ${inspection.status}`);
        files.push(evidence);
        continue;
      }
      const semantic = semanticSha256(inspection.bytes);
      if (inspection.sha256 === evidence.sha256) {
        if (evidence.semanticSha256 === semantic) {
          files.push(evidence);
          continue;
        }
        files.push({ ...evidence, semanticSha256: semantic });
        semanticBackfilled += 1;
        modified = true;
        continue;
      }
      if (evidence.semanticSha256 === semantic) {
        files.push({
          ...evidence,
          sha256: inspection.sha256,
          semanticSha256: semantic
        });
        formattingRehashed += 1;
        modified = true;
        continue;
      }
      semanticChanged.push(evidence.path);
      if (!acceptSourceChanges) {
        files.push(evidence);
        continue;
      }
      files.push({
        ...evidence,
        sha256: inspection.sha256,
        semanticSha256: semantic
      });
      modified = true;
    }

    return {
      files,
      modified,
      semanticBackfilled,
      formattingRehashed,
      semanticChanged,
      unresolved,
      pruned
    };
  };

  private readonly readShard = async (
    projectRoot: string,
    reference: ContextModuleReference
  ): Promise<{ document: ProjectContextModule; sha256: string }> => {
    const inspection = await this.dependencies.files.inspectProjectFile({
      projectRoot,
      relativePath: reference.contextPath,
      maximumBytes: MAX_CONTEXT_SHARD_BYTES
    });
    if (inspection.status !== "inspected" || inspection.bytes === undefined) {
      throw new ContextRefreshError(
        "CONTEXT_INVALID",
        `Context shard cannot be read: ${reference.contextPath}`
      );
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(inspection.bytes.toString("utf8"));
    } catch {
      throw new ContextRefreshError(
        "CONTEXT_INVALID",
        `Context shard is not valid JSON: ${reference.contextPath}`
      );
    }
    const document = ProjectContextModuleSchema.safeParse(parsedJson);
    if (!document.success) {
      throw new ContextRefreshError(
        "CONTEXT_INVALID",
        `Context shard does not match the module schema: ${
          reference.contextPath
        }`
      );
    }
    assertShardIdentity(
      reference,
      document.data,
      (message) => new ContextRefreshError("CONTEXT_INVALID", message)
    );
    return { document: document.data, sha256: inspection.sha256 };
  };

  private readonly writeDocument = async (
    projectRoot: string,
    relativePath: string,
    document: unknown
  ): Promise<string> => {
    const written = await this.dependencies.writer.writeContextDocument({
      projectRoot,
      relativePath,
      document
    });
    if (written.status !== "written") {
      throw new ContextRefreshError(
        "CONTEXT_WRITE_FAILED",
        written.status === "escape"
          ? `Context document resolves outside the project: ${relativePath}`
          : `Context document cannot be written: ${relativePath} (${
              written.message
            })`
      );
    }
    return written.sha256;
  };
}
