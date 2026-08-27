import type {
  ContextModuleReference,
  ProjectContextModule
} from "../../domain/project-context.js";

export function assertShardIdentity(
  reference: ContextModuleReference,
  document: ProjectContextModule,
  createError: (message: string) => Error
): void {
  if (
    document.moduleId !== reference.id
    || document.projectDir !== reference.projectDir
    || document.status !== reference.status
  ) {
    throw createError(
      `Context shard identity does not match its index: ${reference.id}`
    );
  }
}
