import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";

import type {
  ContextDocumentWrite,
  ContextDocumentWriter
} from "../../ports/context-document-writer.js";

function isContained(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot === ""
    || (
      fromRoot !== ".."
      && !fromRoot.startsWith(`..${sep}`)
      && !isAbsolute(fromRoot)
    )
  );
}

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
}
