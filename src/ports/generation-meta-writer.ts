import type { GenerationMeta } from "../domain/generation.js";
import type {
  ProjectBoundFileReader,
  ProjectBoundPath
} from "./project-bound-file.js";

export interface GenerationMetaWriterPort {
  write: (outputPath: string, meta: GenerationMeta) => Promise<void>;
}

export interface ProjectBoundGenerationMetaWriterPort
extends GenerationMetaWriterPort, ProjectBoundFileReader {
  writeProjectBound: (
    path: ProjectBoundPath & { meta: GenerationMeta }
  ) => Promise<void>;
}
