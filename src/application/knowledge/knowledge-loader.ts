import type {
  KnowledgeRegistryPort,
  LoadedKnowledgeBundle
} from "../../ports/knowledge-registry.js";

export type KnowledgeLoadErrorCode =
  | "KNOWLEDGE_INVALID"
  | "KNOWLEDGE_STALE"
  | "KNOWLEDGE_NOT_FOUND";

export class KnowledgeLoadError extends Error {
  public override readonly name = "KnowledgeLoadError";

  public constructor(
    public readonly code: KnowledgeLoadErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export class KnowledgeLoader {
  public constructor(
    private readonly registry: Pick<KnowledgeRegistryPort, "load">
  ) {}

  public readonly load = async (input: {
    projectRoot: string;
    workspaceRoot?: string | undefined;
    packageName?: string | undefined;
    expectedKnowledgeHash?: string | undefined;
  }): Promise<LoadedKnowledgeBundle> => {
    let bundle: LoadedKnowledgeBundle;
    try {
      bundle = await this.registry.load(
        input.projectRoot,
        input.workspaceRoot
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const notFound = (
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT"
      );
      throw new KnowledgeLoadError(
        notFound ? "KNOWLEDGE_NOT_FOUND" : "KNOWLEDGE_INVALID",
        message,
        { cause: error }
      );
    }
    if (
      input.packageName !== undefined
      && bundle.index.packageName !== input.packageName
    ) {
      throw new KnowledgeLoadError(
        "KNOWLEDGE_INVALID",
        "Knowledge package identity does not match the target project"
      );
    }
    if (
      input.expectedKnowledgeHash !== undefined
      && bundle.knowledgeHash !== input.expectedKnowledgeHash
    ) {
      throw new KnowledgeLoadError(
        "KNOWLEDGE_STALE",
        "Knowledge Registry hash changed after it was bound"
      );
    }
    return bundle;
  };
}
