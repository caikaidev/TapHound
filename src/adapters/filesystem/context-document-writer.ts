import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type {
  ContextDocumentWrite,
  ContextDocumentWriter
} from "../../ports/context-document-writer.js";
import { isContained } from "../../shared/paths.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown write failure";
}

export class FileSystemContextDocumentWriter implements ContextDocumentWriter {
  public readonly writeContextDocument = async (input: {
    projectRoot: string;
    relativePath: string;
    document: unknown;
  }): Promise<ContextDocumentWrite> => {
    const normalizedPath = input.relativePath.replaceAll("\\", "/");
    if (
      normalizedPath.length === 0
      || normalizedPath.startsWith("/")
      || /^[A-Za-z]:/.test(normalizedPath)
      || normalizedPath.split("/").includes("..")
    ) {
      return { status: "escape" };
    }

    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(input.projectRoot);
    } catch (error: unknown) {
      return { status: "unwritable", message: errorMessage(error) };
    }

    const target = resolve(canonicalRoot, normalizedPath);
    if (!isContained(canonicalRoot, target)) {
      return { status: "escape" };
    }

    const bytes = `${JSON.stringify(input.document, null, 2)}\n`;
    const directory = dirname(target);
    const temporaryPath = join(
      directory,
      `.${basename(target)}.${randomUUID()}.tmp`
    );
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporaryPath, bytes, "utf8");
      await rename(temporaryPath, target);
    } catch (error: unknown) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      return { status: "unwritable", message: errorMessage(error) };
    }

    return {
      status: "written",
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  };

  public readonly writeContextDocumentBatch = async (input: {
    projectRoot: string;
    documents: readonly {
      relativePath: string;
      document: unknown;
    }[];
  }): Promise<ContextDocumentWrite[]> => {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(input.projectRoot);
    } catch (error: unknown) {
      const failure: ContextDocumentWrite = {
        status: "unwritable",
        message: errorMessage(error)
      };
      return input.documents.map(() => failure);
    }

    interface Prepared {
      readonly target: string;
      readonly tempPath: string;
      readonly bytes: string;
      readonly sha256: string;
    }
    const prepared: Prepared[] = [];
    for (const doc of input.documents) {
      const normalizedPath = doc.relativePath.replaceAll("\\", "/");
      if (
        normalizedPath.length === 0
        || normalizedPath.startsWith("/")
        || /^[A-Za-z]:/.test(normalizedPath)
        || normalizedPath.split("/").includes("..")
      ) {
        for (const item of prepared) {
          await rm(item.tempPath, { force: true }).catch(() => undefined);
        }
        const failure: ContextDocumentWrite = { status: "escape" };
        return input.documents.map(() => failure);
      }
      const target = resolve(canonicalRoot, normalizedPath);
      if (!isContained(canonicalRoot, target)) {
        for (const item of prepared) {
          await rm(item.tempPath, { force: true }).catch(() => undefined);
        }
        const failure: ContextDocumentWrite = { status: "escape" };
        return input.documents.map(() => failure);
      }
      const bytes = `${JSON.stringify(doc.document, null, 2)}\n`;
      const directory = dirname(target);
      const tempPath = join(
        directory,
        `.${basename(target)}.${randomUUID()}.tmp`
      );
      prepared.push({
        target,
        tempPath,
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex")
      });
    }

    try {
      for (const item of prepared) {
        await mkdir(dirname(item.target), { recursive: true });
        await writeFile(item.tempPath, item.bytes, "utf8");
      }
      for (const item of prepared) {
        await rename(item.tempPath, item.target);
      }
    } catch (error: unknown) {
      for (const item of prepared) {
        await rm(item.tempPath, { force: true }).catch(() => undefined);
      }
      const failure: ContextDocumentWrite = {
        status: "unwritable",
        message: errorMessage(error)
      };
      return input.documents.map(() => failure);
    }

    return prepared.map((item) => ({
      status: "written" as const,
      sha256: item.sha256
    }));
  };
}
