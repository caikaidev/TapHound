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
import type {
  ProjectBoundJourneyWriterPort
} from "../../ports/journey-writer.js";
import type { ProjectBoundPath } from "../../ports/project-bound-file.js";
import {
  readProjectBoundFile,
  writeProjectBoundText,
  type ProjectBoundFileHooks
} from "./project-bound-file.js";

export interface FileSystemJourneyWriterOptions {
  beforeBoundInstall?: ProjectBoundFileHooks["beforeInstall"];
}

export class FileSystemJourneyWriter implements ProjectBoundJourneyWriterPort {
  public constructor(
    private readonly options: FileSystemJourneyWriterOptions = {}
  ) {}

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

  public async writeProjectBound(
    input: ProjectBoundPath & { journey: Journey }
  ): Promise<void> {
    const journey = JourneySchema.parse(input.journey);
    await writeProjectBoundText(
      input,
      `${JSON.stringify(journey, null, 2)}\n`,
      this.options.beforeBoundInstall === undefined
        ? {}
        : { beforeInstall: this.options.beforeBoundInstall }
    );
  }

  public async readProjectBound(input: ProjectBoundPath): Promise<Buffer> {
    return readProjectBoundFile(input);
  }
}
