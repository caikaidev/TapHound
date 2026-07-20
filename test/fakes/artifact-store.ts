import type {
  ArtifactSession,
  ArtifactStore
} from "../../src/ports/artifact-store.js";

export class MemoryArtifactSession implements ArtifactSession {
  public readonly temporaryDirectory = "/tmp/taphound-run";
  public readonly finalDirectory = "/reports/taphound-run";
  public readonly text = new Map<string, string>();
  public readonly json = new Map<string, unknown>();
  public published = false;
  public discarded = false;

  public readonly path = (relativePath: string): string => (
    `${this.temporaryDirectory}/${relativePath}`
  );

  public readonly writeText = (
    relativePath: string,
    content: string
  ): Promise<void> => {
    this.text.set(relativePath, content);
    return Promise.resolve();
  };

  public readonly writeJson = (
    relativePath: string,
    value: unknown
  ): Promise<void> => {
    this.json.set(relativePath, value);
    return Promise.resolve();
  };

  public readonly publish = (): Promise<string> => {
    this.published = true;
    return Promise.resolve(this.finalDirectory);
  };

  public readonly discard = (): Promise<void> => {
    this.discarded = true;
    return Promise.resolve();
  };
}

export class MemoryArtifactStore implements ArtifactStore {
  public readonly session = new MemoryArtifactSession();
  public beginCalls: Array<{
    baseDirectory: string;
    runDirectoryName: string;
  }> = [];

  public readonly begin = (
    baseDirectory: string,
    runDirectoryName: string
  ): Promise<ArtifactSession> => {
    this.beginCalls.push({ baseDirectory, runDirectoryName });
    return Promise.resolve(this.session);
  };
}
