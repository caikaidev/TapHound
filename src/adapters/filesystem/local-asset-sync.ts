import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  BUILD_DIR,
  TAPHOUND_DIR
} from "../../domain/workspace.js";
import type {
  LocalAssetSyncPort,
  LocalAssetSyncResult
} from "../../ports/local-asset-sync.js";

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

export class NodeLocalAssetSync implements LocalAssetSyncPort {
  public readonly sync = async (input: {
    projectRoot: string;
    workspaceRoot: string;
    assetDirectories: readonly string[];
  }): Promise<LocalAssetSyncResult> => {
    const syncedDirs: string[] = [];
    let filesCopied = 0;
    for (const dir of input.assetDirectories) {
      const source = join(input.projectRoot, dir);
      const relativeDir = dir.startsWith(`${TAPHOUND_DIR}/`)
        ? dir.slice(TAPHOUND_DIR.length + 1)
        : dir;
      const destination = join(input.workspaceRoot, relativeDir);
      try {
        const sourceStat = await stat(source);
        if (!sourceStat.isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }
      await mkdir(join(input.workspaceRoot, TAPHOUND_DIR), { recursive: true });
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
    return { syncedDirs, filesCopied };
  };
}
