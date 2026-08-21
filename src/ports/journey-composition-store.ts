export interface JourneyCompositionStore {
  read: (input: {
    projectRoot: string;
    relativePath: string;
  }) => Promise<Buffer>;
  listFlowPaths: (projectRoot: string) => Promise<readonly string[]>;
  writeText: (input: {
    projectRoot: string;
    relativePath: string;
    content: string;
  }) => Promise<void>;
}
