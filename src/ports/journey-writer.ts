import type { Journey } from "../domain/journey.js";

export interface JourneyWriterPort {
  write: (outputPath: string, journey: Journey) => Promise<void>;
}
