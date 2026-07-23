import type { GenerationMeta } from "../domain/generation.js";

export interface GenerationMetaWriterPort {
  write: (outputPath: string, meta: GenerationMeta) => Promise<void>;
}
