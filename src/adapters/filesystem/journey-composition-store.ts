import {
  lstat,
  readdir,
  realpath
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";

import {
  BUILD_DIR,
  EXTERNAL_FLOWS_DIR,
  FLOWS_DIR,
  JOURNEYS_DIR,
  TAPHOUND_DIR,
  tapHoundPath
} from "../../domain/workspace.js";
import type {
  JourneyCompositionStore
} from "../../ports/journey-composition-store.js";
import { NodeProjectFileInspector } from "./project-file-inspector.js";
import {
  readProjectBoundFile,
  writeProjectBoundText
} from "./project-bound-file.js";
import { ensureBuildLayout } from "./workspace-layout.js";

const MAX_COMPOSITION_BYTES = 1024 * 1024;

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === ""
    || (
      fromRoot !== ".."
      && !fromRoot.startsWith(`..${sep}`)
      && !isAbsolute(fromRoot)
    );
}

function inspectorBase(
  projectRoot: string,
  workspaceRoot: string | undefined
): string {
  return workspaceRoot ?? projectRoot;
}

function inspectorRelative(
  workspaceRoot: string | undefined,
  relativePath: string
): string {
  return workspaceRoot !== undefined
    && relativePath.startsWith(`${TAPHOUND_DIR}/`)
    ? relativePath.slice(TAPHOUND_DIR.length + 1)
    : relativePath;
}

export class FileSystemJourneyCompositionStore
implements JourneyCompositionStore {
  private readonly inspector = new NodeProjectFileInspector();

  public readonly read = async (input: {
    projectRoot: string;
    relativePath: string;
    workspaceRoot?: string | undefined;
  }): Promise<Buffer> => {
    const inspected = await this.inspector.inspectProjectFile({
      projectRoot: inspectorBase(input.projectRoot, input.workspaceRoot),
      relativePath: inspectorRelative(input.workspaceRoot, input.relativePath),
      maximumBytes: MAX_COMPOSITION_BYTES
    });
    if (inspected.status !== "inspected" || inspected.bytes === undefined) {
      throw new Error(
        `Unable to safely read ${input.relativePath}: ${inspected.status}`
      );
    }
    return inspected.bytes;
  };

  public readonly listFlowPaths = async (
    projectRoot: string,
    workspaceRoot?: string  
  ): Promise<readonly string[]> => {
    const canonicalRoot = await realpath(projectRoot);
    const canonicalWorkspace = workspaceRoot === undefined
      ? undefined
      : await realpath(workspaceRoot);
    const containmentRoot = canonicalWorkspace ?? canonicalRoot;
    const flowRoot = resolve(
      tapHoundPath(canonicalRoot, canonicalWorkspace, FLOWS_DIR)
    );
    try {
      const canonicalFlowRoot = await realpath(flowRoot);
      if (!contained(containmentRoot, canonicalFlowRoot)) {
        throw new Error("Flow directory escapes the project root");
      }
      const rootStats = await lstat(flowRoot);
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw new Error("Flow path is not a safe directory");
      }
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }

    const paths: string[] = [];
    const externalDir = resolve(
      tapHoundPath(canonicalRoot, workspaceRoot, EXTERNAL_FLOWS_DIR)
    );
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          throw new Error(`Flow catalog cannot contain symlinks: ${path}`);
        }
        if (entry.isDirectory()) {
          if (path === externalDir) {
            continue;
          }
          await visit(path);
        } else if (entry.isFile() && entry.name.endsWith(".json")) {
          paths.push(relative(containmentRoot, path).replaceAll("\\", "/"));
        }
      }
    };
    await visit(flowRoot);
    return paths.sort();
  };

  public readonly listJourneyPaths = async (
    projectRoot: string,
    workspaceRoot?: string  
  ): Promise<readonly string[]> => {
    const canonicalRoot = await realpath(projectRoot);
    const canonicalWorkspace = workspaceRoot === undefined
      ? undefined
      : await realpath(workspaceRoot);
    const containmentRoot = canonicalWorkspace ?? canonicalRoot;
    const journeyRoot = resolve(
      tapHoundPath(canonicalRoot, canonicalWorkspace, JOURNEYS_DIR)
    );
    try {
      const canonicalJourneyRoot = await realpath(journeyRoot);
      if (!contained(containmentRoot, canonicalJourneyRoot)) {
        throw new Error("Journey directory escapes the project root");
      }
      const rootStats = await lstat(journeyRoot);
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw new Error("Journey path is not a safe directory");
      }
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }

    const paths: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          throw new Error(`Journey catalog cannot contain symlinks: ${path}`);
        }
        if (entry.isDirectory()) {
          await visit(path);
        } else if (
          entry.isFile()
          && entry.name.endsWith(".json")
          && !entry.name.endsWith(".meta.json")
          && !entry.name.endsWith(".resolve.json")
        ) {
          paths.push(relative(containmentRoot, path).replaceAll("\\", "/"));
        }
      }
    };
    await visit(journeyRoot);
    return paths.sort();
  };

  public readonly readJourneyMeta = async (input: {
    projectRoot: string;
    journeyPath: string;
    workspaceRoot?: string | undefined;
  }): Promise<Buffer | null> => {
    if (
      !input.journeyPath.endsWith(".json")
      || input.journeyPath.endsWith(".meta.json")
      || input.journeyPath.endsWith(".resolve.json")
    ) {
      throw new Error(
        `Journey path must be a normalized JSON file: ${input.journeyPath}`
      );
    }
    const metaPath = `${input.journeyPath.slice(0, -".json".length)}.meta.json`;
    const inspected = await this.inspector.inspectProjectFile({
      projectRoot: inspectorBase(input.projectRoot, input.workspaceRoot),
      relativePath: inspectorRelative(input.workspaceRoot, metaPath),
      maximumBytes: MAX_COMPOSITION_BYTES
    });
    if (inspected.status === "notFound") {
      return null;
    }
    if (inspected.status !== "inspected" || inspected.bytes === undefined) {
      throw new Error(
        `Unable to safely read ${metaPath}: ${inspected.status}`
      );
    }
    return inspected.bytes;
  };

  public readonly writeText = async (input: {
    projectRoot: string;
    relativePath: string;
    content: string;
  }): Promise<void> => {
    await ensureBuildLayout(input.projectRoot);
    await writeProjectBoundText({
      projectRoot: input.projectRoot,
      authorityRoot: resolve(input.projectRoot, BUILD_DIR),
      outputPath: resolve(input.projectRoot, input.relativePath)
    }, input.content);
  };

  public readonly readOutput = async (input: {
    projectRoot: string;
    relativePath: string;
  }): Promise<Buffer> => {
    await ensureBuildLayout(input.projectRoot);
    return readProjectBoundFile({
      projectRoot: input.projectRoot,
      authorityRoot: resolve(input.projectRoot, BUILD_DIR),
      outputPath: resolve(input.projectRoot, input.relativePath)
    });
  };
}
