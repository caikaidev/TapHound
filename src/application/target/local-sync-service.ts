import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  BUILD_DIR,
  BASELINES_DIR,
  CONTRACTS_DIR,
  CONTEXT_DIR,
  JOURNEYS_DIR,
  KNOWLEDGE_DIR,
  PLAYBOOKS_DIR,
  TAPHOUND_DIR
} from "../../domain/workspace.js";

export interface LocalSyncDependencies {
  workspaceRoot: (targetsHome: string, targetId: string) => string;
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
    const syncedDirs: string[] = [];
    let filesCopied = 0;
    for (const dir of SYNC_DIRS) {
      const source = join(input.projectRoot, dir);
      const relativeDir = dir.startsWith(`${TAPHOUND_DIR}/`)
        ? dir.slice(TAPHOUND_DIR.length + 1)
        : dir;
      const destination = join(workspaceRoot, relativeDir);
      try {
        const sourceStat = await stat(source);
        if (!sourceStat.isDirectory()) {
          continue;
        }
      } catch {
        // Source asset does not exist in the project; skip.
        continue;
      }
      await mkdir(join(workspaceRoot, TAPHOUND_DIR), { recursive: true });
      const copied = await copyTree(source, destination).catch((error: unknown) => {
        throw new Error(
          `local sync failed copying ${relative(input.projectRoot, source)}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
      filesCopied += copied;
      syncedDirs.push(dir);
    }
    return {
      targetId: input.targetId,
      projectRoot: input.projectRoot,
      workspaceRoot,
      syncedDirs,
      filesCopied,
      skippedBuild: true
    };
  };
}

async function copyTree(
  source: string,
  destination: string
): Promise<number> {
  let count = 0;
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === BUILD_DIR) {
        continue;
      }
      count += await copyTree(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await mkdir(destination, { recursive: true });
      await cp(sourcePath, destinationPath);
      count += 1;
    }
  }
  return count;
}

export { SYNC_DIRS };