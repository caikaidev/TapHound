import { resolve } from "node:path";

import {
  ProjectContextModuleSchema,
  ProjectContextSchema,
  ResolvedProjectContextSchema,
  type ContextModuleReference,
  type ProjectContext,
  type ProjectContextModule,
  type ResolvedProjectContext
} from "../../domain/project-context.js";
import type {
  ProjectFileInspection,
  ProjectFileInspector
} from "../../ports/project-file-inspector.js";
import type {
  ProjectInventoryInspector
} from "../../ports/project-inventory-inspector.js";
import { projectRelativePath } from "../../shared/paths.js";
import { compareStrings } from "../../shared/strings.js";
import { assertShardIdentity } from "./shard-identity.js";

export const MAX_CONTEXT_SHARD_BYTES = 4 * 1024 * 1024;

export type ContextLoadErrorCode =
  | "CONTEXT_INVALID"
  | "CONTEXT_STALE"
  | "CONTEXT_MODULE_NOT_FOUND"
  | "CONTEXT_MODULE_INCOMPLETE";

export class ContextLoadError extends Error {
  public override readonly name = "ContextLoadError";

  public constructor(
    public readonly code: ContextLoadErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface LoadedProjectContext {
  context: ResolvedProjectContext;
  bundle: ProjectContext;
  modules: ProjectContextModule[];
}

export interface LoadedContextIndex {
  bundle: ProjectContext;
  indexHash: string;
}

export interface ContextLoadInput {
  projectRoot: string;
  contextPath: string;
  moduleIds?: string[] | undefined;
  allowIncomplete?: boolean | undefined;
}

export interface ContextLoaderDependencies {
  files: ProjectFileInspector;
  inventory: ProjectInventoryInspector;
  readJson: (path: string) => Promise<unknown>;
}

interface StableContextDocument {
  document: unknown;
  sha256: string;
}

function inspectionMessage(
  path: string,
  inspection: Exclude<ProjectFileInspection, { status: "inspected" }>
): string {
  switch (inspection.status) {
    case "rootNotFound":
    case "rootUnreadable":
      return "Project root does not exist or cannot be read";
    case "rootNotDirectory":
      return "Project root is not a directory";
    case "notFound":
      return `Context shard does not exist: ${path}`;
    case "unreadable":
      return `Context shard cannot be read: ${path}`;
    case "escape":
      return `Context shard resolves outside the project: ${path}`;
    case "changedIdentity":
      return `Context shard changed during inspection: ${path}`;
    case "notFile":
      return `Context shard path is not a file: ${path}`;
    case "tooLarge":
      return `Context shard exceeds ${String(MAX_CONTEXT_SHARD_BYTES)} bytes: ${path}`;
  }
}

function selectedReferences(
  bundle: ProjectContext,
  requestedIds: string[] | undefined
): ContextModuleReference[] {
  const byId = new Map(bundle.modules.map((module) => [module.id, module]));
  const selected = new Set<string>(
    requestedIds === undefined || requestedIds.length === 0
      ? bundle.modules.map((module) => module.id)
      : [
          ...bundle.modules
            .filter((module) => module.kind === "application")
            .map((module) => module.id),
          ...requestedIds
        ]
  );
  const pending = [...selected];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined) {
      continue;
    }
    const module = byId.get(id);
    if (module === undefined) {
      throw new ContextLoadError(
        "CONTEXT_MODULE_NOT_FOUND",
        `Project Context module does not exist: ${id}`
      );
    }
    for (const dependency of module.dependsOn) {
      if (!selected.has(dependency)) {
        selected.add(dependency);
        pending.push(dependency);
      }
    }
  }
  return bundle.modules.filter((module) => selected.has(module.id));
}

function effectiveContext(
  bundle: ProjectContext,
  modules: ProjectContextModule[],
  indexHash: string
): ResolvedProjectContext {
  const evidence = [
    ...bundle.manifest.files,
    ...modules.flatMap((module) => module.manifest.files)
  ];
  const byPath = new Map<string, (typeof evidence)[number]>();
  for (const file of evidence) {
    const existing = byPath.get(file.path);
    if (existing !== undefined && existing.sha256 !== file.sha256) {
      throw new ContextLoadError(
        "CONTEXT_INVALID",
        `Conflicting Context evidence hash for ${file.path}`
      );
    }
    byPath.set(file.path, file);
  }
  return ResolvedProjectContextSchema.parse({
    version: 2,
    packageName: bundle.packageName,
    launchActivity: bundle.launchActivity,
    manifest: {
      version: 1,
      files: [...byPath.values()].sort((left, right) => (
        compareStrings(left.path, right.path)
      ))
    },
    interactionPolicy: bundle.interactionPolicy,
    selection: {
      bundleVersion: 2,
      indexHash,
      modules: modules.map((module) => {
        const reference = bundle.modules.find(
          (candidate) => candidate.id === module.moduleId
        );
        if (reference === undefined) {
          throw new ContextLoadError(
            "CONTEXT_INVALID",
            `Context shard is missing from its index: ${module.moduleId}`
          );
        }
        return {
          id: reference.id,
          sha256: reference.sha256,
          projectDir: module.projectDir,
          inventory: {
            pathSetSha256: module.inventory.pathSetSha256,
            categories: module.inventory.categories
          }
        };
      })
    }
  });
}

function sameStrings(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort(compareStrings);
  const sortedRight = [...right].sort(compareStrings);
  return sortedLeft.every(
    (value, index) => value === sortedRight[index]
  );
}

export class ContextLoader {
  public constructor(private readonly dependencies: ContextLoaderDependencies) {}

  private readonly readStableDocument = async (input: {
    projectRoot: string;
    relativePath: string;
    label: string;
  }): Promise<StableContextDocument> => {
    const before = await this.dependencies.files.inspectProjectFile({
      projectRoot: input.projectRoot,
      relativePath: input.relativePath,
      maximumBytes: MAX_CONTEXT_SHARD_BYTES
    });
    if (before.status !== "inspected") {
      throw new ContextLoadError(
        "CONTEXT_INVALID",
        inspectionMessage(input.relativePath, before)
      );
    }
    let document: unknown;
    try {
      document = await this.dependencies.readJson(
        resolve(input.projectRoot, input.relativePath)
      );
    } catch (error) {
      throw new ContextLoadError(
        "CONTEXT_INVALID",
        error instanceof Error ? error.message : `Unable to read ${input.label}`
      );
    }
    const after = await this.dependencies.files.inspectProjectFile({
      projectRoot: input.projectRoot,
      relativePath: input.relativePath,
      maximumBytes: MAX_CONTEXT_SHARD_BYTES
    });
    if (
      after.status !== "inspected"
      || after.sha256 !== before.sha256
    ) {
      throw new ContextLoadError(
        "CONTEXT_INVALID",
        `${input.label} changed while loading`
      );
    }
    return { document, sha256: before.sha256 };
  };

  public readonly readIndex = async (input: {
    projectRoot: string;
    contextPath: string;
  }): Promise<LoadedContextIndex> => {
    const contextPath = projectRelativePath(
      input.projectRoot,
      input.contextPath,
      (message) => new ContextLoadError("CONTEXT_INVALID", message)
    );
    const loaded = await this.readStableDocument({
      projectRoot: input.projectRoot,
      relativePath: contextPath,
      label: "Project Context index"
    });
    const parsedBundle = ProjectContextSchema.safeParse(loaded.document);
    if (!parsedBundle.success) {
      throw new ContextLoadError(
        "CONTEXT_INVALID",
        "Project Context does not match the version 2 index schema"
      );
    }
    return {
      bundle: parsedBundle.data,
      indexHash: loaded.sha256
    };
  };

  public readonly load = async (
    input: ContextLoadInput
  ): Promise<LoadedProjectContext> => {
    const { bundle, indexHash } = await this.readIndex(input);
    const references = selectedReferences(bundle, input.moduleIds);
    if (input.allowIncomplete !== true) {
      const incomplete = references.find((module) => module.status !== "complete");
      if (incomplete !== undefined) {
        throw new ContextLoadError(
          "CONTEXT_MODULE_INCOMPLETE",
          `Project Context module is ${incomplete.status}: ${incomplete.id}`
        );
      }
    }

    const modules: ProjectContextModule[] = [];
    for (const reference of references) {
      const loaded = await this.readStableDocument({
        projectRoot: input.projectRoot,
        relativePath: reference.contextPath,
        label: `Context shard ${reference.contextPath}`
      });
      if (loaded.sha256 !== reference.sha256) {
        throw new ContextLoadError(
          "CONTEXT_STALE",
          `Context shard changed: ${reference.contextPath}`
        );
      }
      const module = ProjectContextModuleSchema.safeParse(loaded.document);
      if (!module.success) {
        throw new ContextLoadError(
          "CONTEXT_INVALID",
          `Context shard does not match the module schema: ${reference.contextPath}`
        );
      }
      assertShardIdentity(
        reference,
        module.data,
        (message) => new ContextLoadError("CONTEXT_INVALID", message)
      );
      if (
        !sameStrings(reference.features, module.data.summary.features)
        || !sameStrings(
          reference.activities,
          module.data.summary.activities.map((activity) => activity.name)
        )
      ) {
        throw new ContextLoadError(
          "CONTEXT_INVALID",
          `Context shard routing summary does not match its index: ${reference.id}`
        );
      }
      const inventory = await this.dependencies.inventory.inspectProjectInventory({
        projectRoot: input.projectRoot,
        projectDir: module.data.projectDir,
        categories: module.data.inventory.categories
      });
      if (inventory.status !== "inspected") {
        throw new ContextLoadError(
          "CONTEXT_INVALID",
          `Unable to inspect module inventory: ${reference.id}`
        );
      }
      if (inventory.pathSetSha256 !== module.data.inventory.pathSetSha256) {
        throw new ContextLoadError(
          "CONTEXT_STALE",
          `Module file inventory changed: ${reference.id}`
        );
      }
      modules.push(module.data);
    }

    const context = effectiveContext(bundle, modules, indexHash);
    return {
      context,
      bundle,
      modules
    };
  };
}
