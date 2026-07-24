import type { Journey } from "../domain/journey.js";
import type {
  ProjectBoundFileReader,
  ProjectBoundPath
} from "./project-bound-file.js";

export interface JourneyWriterPort {
  write: (outputPath: string, journey: Journey) => Promise<void>;
}

export interface ProjectBoundJourneyWriterPort
extends JourneyWriterPort, ProjectBoundFileReader {
  writeProjectBound: (
    path: ProjectBoundPath & { journey: Journey }
  ) => Promise<void>;
}
