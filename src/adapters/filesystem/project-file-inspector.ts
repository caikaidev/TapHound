import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";

import {
  ProjectFileInspectionError,
  type ProjectFileInspection,
  type ProjectFileInspectionFailure,
  type ProjectFileInspector
} from "../../ports/project-file-inspector.js";

function failureFor(error: unknown): ProjectFileInspectionFailure {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT"
  )
    ? "notFound"
    : "unreadable";
}

function inspectionError(path: string, error: unknown): ProjectFileInspectionError {
  const failure = failureFor(error);
  return new ProjectFileInspectionError(
    failure,
    failure === "notFound"
      ? `Project file does not exist: ${path}`
      : `Project file cannot be read: ${path}`
  );
}

export class NodeProjectFileInspector implements ProjectFileInspector {
  public readonly realPath = async (path: string): Promise<string> => {
    try {
      return await realpath(path);
    } catch (error: unknown) {
      throw inspectionError(path, error);
    }
  };

  public readonly inspectFile = async (
    realPath: string,
    maximumBytes: number
  ): Promise<ProjectFileInspection> => {
    try {
      const fileStats = await stat(realPath);
      if (!fileStats.isFile()) {
        return { status: "notFile" };
      }
      if (fileStats.size > maximumBytes) {
        return { status: "tooLarge", size: fileStats.size };
      }

      const handle = await open(realPath, "r");
      try {
        const content = await handle.readFile();
        if (content.byteLength > maximumBytes) {
          return { status: "tooLarge", size: content.byteLength };
        }
        return {
          status: "inspected",
          size: content.byteLength,
          sha256: createHash("sha256").update(content).digest("hex")
        };
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      throw inspectionError(realPath, error);
    }
  };
}
