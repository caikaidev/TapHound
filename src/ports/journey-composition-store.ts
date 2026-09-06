export interface JourneyCompositionStore {
  read: (input: {
    projectRoot: string;
    relativePath: string;
  }) => Promise<Buffer>;
  listFlowPaths: (projectRoot: string) => Promise<readonly string[]>;
  listJourneyPaths: (projectRoot: string) => Promise<readonly string[]>;
  readJourneyMeta: (input: {
    projectRoot: string;
    journeyPath: string;
  }) => Promise<Buffer | null>;
  writeText: (input: {
    projectRoot: string;
    relativePath: string;
    content: string;
  }) => Promise<void>;
}
