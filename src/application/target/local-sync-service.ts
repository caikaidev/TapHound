import {
  BASELINES_DIR,
  CONTRACTS_DIR,
  CONTEXT_DIR,
  JOURNEYS_DIR,
  KNOWLEDGE_DIR,
  PLAYBOOKS_DIR
} from "../../domain/workspace.js";
import type { LocalAssetSyncPort } from "../../ports/local-asset-sync.js";

export interface LocalSyncDependencies {
  workspaceRoot: (targetsHome: string, targetId: string) => string;
  assetSync: LocalAssetSyncPort;
}

export interface LocalSyncResult {
  targetId: string;
  projectRoot: string;
  workspaceRoot: string;
  syncedDirs: string[];
  filesCopied: number;
  skippedBuild: boolean;
}

/** Asset directories that are synced from the project into the workspace. */
const SYNC_DIRS = [
  CONTEXT_DIR,
  JOURNEYS_DIR,
  KNOWLEDGE_DIR,
  CONTRACTS_DIR,
  PLAYBOOKS_DIR,
  BASELINES_DIR
] as const;

/**
 * Copies committed TapHound assets (context, journeys, knowledge, contracts,
 * playbooks, baselines) from a project into a local target's workspace so
 * `--target` mode can load them there. The workspace `build/` subtree stays
 * untouched: it is the runtime-isolated area. Sync is idempotent: repeated
 * runs copy only what changed (recursive copy of full dirs; no deletions).
 */
export class LocalSyncService {
  public constructor(
    private readonly dependencies: LocalSyncDependencies
  ) {}

  public readonly sync = async (input: {
    targetId: string;
    projectRoot: string;
    targetsHome: string;
  }): Promise<LocalSyncResult> => {
    const workspaceRoot = this.dependencies.workspaceRoot(
      input.targetsHome,
      input.targetId
    );
    const synced = await this.dependencies.assetSync.sync({
      projectRoot: input.projectRoot,
      workspaceRoot,
      assetDirectories: SYNC_DIRS
    });
    return {
      targetId: input.targetId,
      projectRoot: input.projectRoot,
      workspaceRoot,
      syncedDirs: synced.syncedDirs,
      filesCopied: synced.filesCopied,
      skippedBuild: true
    };
  };
}

export { SYNC_DIRS };