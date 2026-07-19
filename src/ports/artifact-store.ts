export interface ArtifactSession {
  readonly temporaryDirectory: string;
  readonly finalDirectory: string;
  path: (relativePath: string) => string;
  writeText: (relativePath: string, content: string) => Promise<void>;
  writeJson: (relativePath: string, value: unknown) => Promise<void>;
  publish: () => Promise<string>;
  discard: () => Promise<void>;
}

export interface ArtifactStore {
  begin: (
    baseDirectory: string,
    runDirectoryName: string
  ) => Promise<ArtifactSession>;
}
