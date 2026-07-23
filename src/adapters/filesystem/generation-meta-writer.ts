import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  GenerationMetaSchema,
  type GenerationMeta
} from "../../domain/generation.js";
import type {
  ProjectBoundGenerationMetaWriterPort
} from "../../ports/generation-meta-writer.js";
import type {
  ProjectBoundPath
} from "../../ports/project-bound-file.js";
import {
  readProjectBoundFile,
  writeProjectBoundText,
  type ProjectBoundFileHooks
} from "./project-bound-file.js";

export interface FileSystemGenerationMetaWriterOptions {
  beforeBoundInstall?: ProjectBoundFileHooks["beforeInstall"];
}

export class FileSystemGenerationMetaWriter
implements ProjectBoundGenerationMetaWriterPort {
  public constructor(
    private readonly options: FileSystemGenerationMetaWriterOptions = {}
  ) {}

  public async write(outputPath: string, input: GenerationMeta): Promise<void> {
    const meta = GenerationMetaSchema.parse(input);
    const directory = dirname(outputPath);
    const temporaryPath = join(
      directory,
      `.${basename(outputPath)}.${randomUUID()}.tmp`
    );
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(meta, null, 2)}\n`,
        "utf8"
      );
      await rename(temporaryPath, outputPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  public async writeProjectBound(
    input: ProjectBoundPath & { meta: GenerationMeta }
  ): Promise<void> {
    const meta = GenerationMetaSchema.parse(input.meta);
    await writeProjectBoundText(
      input,
      `${JSON.stringify(meta, null, 2)}\n`,
      this.options.beforeBoundInstall === undefined
        ? {}
        : { beforeInstall: this.options.beforeBoundInstall }
    );
  }

  public async readProjectBound(input: ProjectBoundPath): Promise<Buffer> {
    return readProjectBoundFile(input);
  }
}
