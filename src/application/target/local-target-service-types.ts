import type {
  LocalTargetIdentity,
  ProjectFingerprint,
  ResolvedTarget
} from "../../domain/target.js";

export interface LocalTargetIdentityStore {
  readIdentity: (targetId: string) => Promise<LocalTargetIdentity | null>;
  writeIdentity: (identity: LocalTargetIdentity) => Promise<void>;
  ensureWorkspace: (targetId: string) => Promise<void>;
}

export interface LocalTargetServiceDependencies {
  identityStore: LocalTargetIdentityStore;
  fingerprint: (
    project: ResolvedTarget["project"],
    packageName?: string
  ) => Promise<Pick<ProjectFingerprint, "hash">>;
}