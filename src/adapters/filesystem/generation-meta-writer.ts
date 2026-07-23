import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  GenerationMetaSchema,
  type GenerationMeta
} from "../../domain/generation.js";
import type {
  GenerationMetaWriterPort
} from "../../ports/generation-meta-writer.js";

export class FileSystemGenerationMetaWriter
implements GenerationMetaWriterPort {
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
}
