export interface JourneyCompositionStore {
  read: (input: {
    projectRoot: string;
    relativePath: string;
    workspaceRoot?: string | undefined;
  }) => Promise<Buffer>;
  listFlowPaths: (
    projectRoot: string,
    workspaceRoot?: string  
  ) => Promise<readonly string[]>;
  listJourneyPaths: (
    projectRoot: string,
    workspaceRoot?: string  
  ) => Promise<readonly string[]>;
  readJourneyMeta: (input: {
    projectRoot: string;
    journeyPath: string;
    workspaceRoot?: string | undefined;
  }) => Promise<Buffer | null>;
  writeText: (input: {
    projectRoot: string;
    relativePath: string;
    content: string;
    workspaceRoot?: string | undefined;
  }) => Promise<void>;
}
