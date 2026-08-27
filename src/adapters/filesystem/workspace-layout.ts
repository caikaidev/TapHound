import {
  constants,
  lstat,
  mkdir,
  open,
  readdir,
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
import { isErrnoException } from "../../shared/errors.js";
import { compareStrings } from "../../shared/strings.js";

const STRAY_RUN_DIRECTORY = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function findLegacyDirectories(
  projectRoot: string
): Promise<readonly string[]> {
  try {
    const entries = await readdir(join(projectRoot, TAPHOUND_DIR), {
      withFileTypes: true
    });
    const legacyNames = new Set(LEGACY_WORKSPACE_DIRECTORIES.map(
      (path) => path.slice(TAPHOUND_DIR.length + 1)
    ));
    return entries
      .filter((entry) => (
        legacyNames.has(entry.name)
        || STRAY_RUN_DIRECTORY.test(entry.name)
      ) && (entry.isDirectory() || entry.isSymbolicLink()))
      .map((entry) => `${TAPHOUND_DIR}/${entry.name}`)
      .sort((left, right) => compareStrings(left, right));
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
    return [];
  }
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
    if (!isErrnoException(error) || error.code !== "EEXIST") {
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
    if (!isErrnoException(error) || error.code !== "EEXIST") {
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

  public readonly ensureBuildLayout = async (
    projectRoot: string
  ): Promise<void> => {
    await ensureBuildLayout(projectRoot);
  };
}
