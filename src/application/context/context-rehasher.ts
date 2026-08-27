import {
  ProjectContextModuleSchema,
  ProjectContextSchema,
  type ProjectContext
} from "../../domain/project-context.js";
import type {
  ContextDocumentWriter
} from "../../ports/context-document-writer.js";
import type {
  ProjectFileInspector
} from "../../ports/project-file-inspector.js";
import { projectRelativePath } from "../../shared/paths.js";
import { MAX_CONTEXT_SHARD_BYTES, type ContextLoader } from "./context-loader.js";
import { assertShardIdentity } from "./shard-identity.js";

export type ContextRehashErrorCode =
  | "CONTEXT_INVALID"
  | "CONTEXT_MODULE_NOT_FOUND"
  | "CONTEXT_WRITE_FAILED";

export class ContextRehashError extends Error {
  public override readonly name = "ContextRehashError";

  public constructor(
    public readonly code: ContextRehashErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface ContextRehashInput {
  readonly projectRoot: string;
  readonly contextPath: string;
  readonly moduleIds?: readonly string[] | undefined;
}

export interface ContextRehashModuleResult {
  readonly id: string;
  readonly previousSha256: string;
  readonly currentSha256: string;
  readonly changed: boolean;
}

export interface ContextRehashResult {
  readonly status: "rehashed" | "unchanged";
  readonly modules: readonly ContextRehashModuleResult[];
  readonly previousIndexHash: string;
  readonly indexHash: string;
}

export interface ContextRehasherDependencies {
  readonly files: ProjectFileInspector;
  readonly loader: Pick<ContextLoader, "readIndex">;
  readonly writer: ContextDocumentWriter;
}

export class ContextRehasher {
  public constructor(
    private readonly dependencies: ContextRehasherDependencies
  ) {}

  public readonly rehash = async (
    input: ContextRehashInput
  ): Promise<ContextRehashResult> => {
    const contextRelativePath = projectRelativePath(
      input.projectRoot,
      input.contextPath,
      (message) => new ContextRehashError("CONTEXT_INVALID", message)
    );

    const { bundle, indexHash } = await this.dependencies.loader.readIndex({
      projectRoot: input.projectRoot,
      contextPath: input.contextPath
    });

    const requestedIds = input.moduleIds === undefined || input.moduleIds.length === 0
      ? undefined
      : new Set(input.moduleIds);

    const moduleResults: ContextRehashModuleResult[] = [];
    let anyChanged = false;

    for (const reference of bundle.modules) {
      if (requestedIds !== undefined && !requestedIds.has(reference.id)) {
        continue;
      }

      const inspection = await this.dependencies.files.inspectProjectFile({
        projectRoot: input.projectRoot,
        relativePath: reference.contextPath,
        maximumBytes: MAX_CONTEXT_SHARD_BYTES
      });
      if (inspection.status !== "inspected") {
        throw new ContextRehashError(
          "CONTEXT_INVALID",
          `Context shard cannot be read: ${reference.contextPath}`
        );
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(inspection.bytes?.toString("utf8") ?? "");
      } catch {
        throw new ContextRehashError(
          "CONTEXT_INVALID",
          `Context shard is not valid JSON: ${reference.contextPath}`
        );
      }

      const document = ProjectContextModuleSchema.safeParse(parsedJson);
      if (!document.success) {
        throw new ContextRehashError(
          "CONTEXT_INVALID",
          `Context shard does not match the module schema: ${reference.contextPath}`
        );
      }

      assertShardIdentity(
        reference,
        document.data,
        (message) => new ContextRehashError("CONTEXT_INVALID", message)
      );

      const changed = inspection.sha256 !== reference.sha256;
      if (changed) {
        anyChanged = true;
      }
      moduleResults.push({
        id: reference.id,
        previousSha256: reference.sha256,
        currentSha256: inspection.sha256,
        changed
      });
    }

    if (!anyChanged) {
      return {
        status: "unchanged",
        modules: moduleResults,
        previousIndexHash: indexHash,
        indexHash
      };
    }

    const nextModules = bundle.modules.map((reference) => {
      const result = moduleResults.find((r) => r.id === reference.id);
      return result !== undefined && result.changed
        ? { ...reference, sha256: result.currentSha256 }
        : reference;
    });

    const nextBundle: ProjectContext = {
      ...bundle,
      modules: nextModules
    };

    const parsedBundle = ProjectContextSchema.safeParse(nextBundle);
    if (!parsedBundle.success) {
      throw new ContextRehashError(
        "CONTEXT_INVALID",
        "Rehashed Project Context index does not match the version 2 schema"
      );
    }

    const written = await this.dependencies.writer.writeContextDocument({
      projectRoot: input.projectRoot,
      relativePath: contextRelativePath,
      document: parsedBundle.data
    });
    if (written.status !== "written") {
      throw new ContextRehashError(
        "CONTEXT_WRITE_FAILED",
        written.status === "escape"
          ? `Context document resolves outside the project: ${contextRelativePath}`
          : `Context document cannot be written: ${contextRelativePath}${"message" in written ? `: ${written.message}` : ""}`
      );
    }

    return {
      status: "rehashed",
      modules: moduleResults,
      previousIndexHash: indexHash,
      indexHash: written.sha256
    };
  };
}
