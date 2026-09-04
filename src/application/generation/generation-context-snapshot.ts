import {
  ResolvedProjectContextSchema,
  type ResolvedProjectContext
} from "../../domain/project-context.js";
import { GENERATION_CONTEXT_SNAPSHOT_PATH } from "../../domain/workspace.js";
import {
  GenerationSessionStoreError,
  type GenerationSessionStore
} from "../../ports/generation-session-store.js";
import {
  GenerationOperationError,
  hashGenerationBinding
} from "./generation-starter.js";

export interface GenerationContextSnapshotDependencies {
  store: Pick<GenerationSessionStore, "read" | "readEvidence">;
}

export const readGenerationContextSnapshot = async (
  dependencies: GenerationContextSnapshotDependencies,
  sessionId: string
): Promise<ResolvedProjectContext | null> => {
  let bytes: Buffer;
  try {
    bytes = await dependencies.store.readEvidence(
      sessionId,
      GENERATION_CONTEXT_SNAPSHOT_PATH
    );
  } catch (error) {
    if (
      error instanceof GenerationSessionStoreError
      && error.code === "EVIDENCE_NOT_FOUND"
    ) {
      return null;
    }
    throw error;
  }
  let context: ResolvedProjectContext;
  try {
    context = ResolvedProjectContextSchema.parse(
      JSON.parse(bytes.toString("utf8")) as unknown
    );
  } catch {
    throw new GenerationOperationError(
      "CONTEXT_INVALID",
      "Stored context snapshot is unreadable"
    );
  }
  const session = await dependencies.store.read(sessionId);
  if (hashGenerationBinding(context) !== session.bindings.contextHash) {
    throw new GenerationOperationError(
      "CONTEXT_INVALID",
      "Stored context snapshot does not match the session context binding"
    );
  }
  return context;
};
