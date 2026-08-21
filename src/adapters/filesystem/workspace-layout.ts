import {
  constants,
  lstat,
  mkdir,
  open,
  realpath
} from "node:fs/promises";
import { join } from "node:path";

import {
  BUILD_DIR,
  BUILD_IGNORE_CONTENT,
  BUILD_IGNORE_FILE,
  LEGACY_WORKSPACE_DIRECTORIES,
  TAPHOUND_DIR
} from "../../domain/workspace.js";
import type { WorkspaceLayoutPort } from "../../ports/workspace-layout.js";

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function findLegacyDirectories(
  projectRoot: string
): Promise<readonly string[]> {
  const found: string[] = [];
  for (const relativePath of LEGACY_WORKSPACE_DIRECTORIES) {
    try {
      const stats = await lstat(join(projectRoot, relativePath));
      if (stats.isDirectory() || stats.isSymbolicLink()) {
        found.push(relativePath);
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return found;
}

export async function ensureBuildIgnored(projectRoot: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      join(projectRoot, BUILD_IGNORE_FILE),
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o644
    );
    await handle.writeFile(BUILD_IGNORE_CONTENT, "utf8");
    await handle.sync();
  } catch (error) {
    // A file the developer already owns is never rewritten.
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function createOrRequireDirectory(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw error;
    }
  }
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Workspace path is not a safe directory: ${path}`);
  }
}

export async function ensureBuildLayout(projectRoot: string): Promise<void> {
  const canonicalRoot = await realpath(projectRoot);
  const rootStats = await lstat(canonicalRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Project root is not a safe directory: ${projectRoot}`);
  }
  const taphoundDirectory = join(canonicalRoot, TAPHOUND_DIR);
  await createOrRequireDirectory(taphoundDirectory);
  await createOrRequireDirectory(join(canonicalRoot, BUILD_DIR));
  await ensureBuildIgnored(canonicalRoot);
}

export class FileSystemWorkspaceLayout implements WorkspaceLayoutPort {
  public readonly findLegacyDirectories = async (
    projectRoot: string
  ): Promise<readonly string[]> => findLegacyDirectories(projectRoot);

  public readonly ensureBuildIgnored = async (
    projectRoot: string
  ): Promise<void> => {
    await ensureBuildIgnored(projectRoot);
  };
}
