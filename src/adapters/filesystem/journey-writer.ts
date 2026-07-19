import { randomUUID } from "node:crypto";
import {
  mkdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import {
  basename,
  dirname,
  join
} from "node:path";

import { JourneySchema, type Journey } from "../../domain/journey.js";
import type { JourneyWriterPort } from "../../ports/journey-writer.js";

export class FileSystemJourneyWriter implements JourneyWriterPort {
  public async write(outputPath: string, input: Journey): Promise<void> {
    const journey = JourneySchema.parse(input);
    const directory = dirname(outputPath);
    const temporaryPath = join(
      directory,
      `.${basename(outputPath)}.${randomUUID()}.tmp`
    );
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(journey, null, 2)}\n`,
        "utf8"
      );
      await rename(temporaryPath, outputPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}
