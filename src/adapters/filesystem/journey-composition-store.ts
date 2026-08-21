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
  FLOWS_DIR
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

export class FileSystemJourneyCompositionStore
implements JourneyCompositionStore {
  private readonly inspector = new NodeProjectFileInspector();

  public readonly read = async (input: {
    projectRoot: string;
    relativePath: string;
  }): Promise<Buffer> => {
    const inspected = await this.inspector.inspectProjectFile({
      projectRoot: input.projectRoot,
      relativePath: input.relativePath,
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
    projectRoot: string
  ): Promise<readonly string[]> => {
    const canonicalRoot = await realpath(projectRoot);
    const flowRoot = resolve(canonicalRoot, FLOWS_DIR);
    try {
      const canonicalFlowRoot = await realpath(flowRoot);
      if (!contained(canonicalRoot, canonicalFlowRoot)) {
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
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          throw new Error(`Flow catalog cannot contain symlinks: ${path}`);
        }
        if (entry.isDirectory()) {
          await visit(path);
        } else if (entry.isFile() && entry.name.endsWith(".json")) {
          paths.push(relative(canonicalRoot, path).replaceAll("\\", "/"));
        }
      }
    };
    await visit(flowRoot);
    return paths.sort();
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
