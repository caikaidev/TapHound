import {
  access,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve
} from "node:path";

import type {
  ArtifactSession,
  ArtifactStore
} from "../../ports/artifact-store.js";

function assertRunDirectoryName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error("Invalid artifact run directory name");
  }
}

function safePath(root: string, relativePath: string): string {
  const candidate = resolve(root, relativePath);
  const fromRoot = relative(root, candidate);
  if (
    fromRoot.length === 0
    || fromRoot.startsWith("..")
    || isAbsolute(fromRoot)
  ) {
    throw new Error(`Invalid artifact path: ${relativePath}`);
  }
  return candidate;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

class FileSystemArtifactSession implements ArtifactSession {
  private published = false;
  private discarded = false;

  public constructor(
    public readonly temporaryDirectory: string,
    public readonly finalDirectory: string
  ) {}

  public readonly path = (relativePath: string): string => (
    safePath(
      this.published ? this.finalDirectory : this.temporaryDirectory,
      relativePath
    )
  );

  public readonly writeText = async (
    relativePath: string,
    content: string
  ): Promise<void> => {
    this.assertWritable();
    const outputPath = safePath(this.temporaryDirectory, relativePath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, content, "utf8");
  };

  public readonly writeJson = (
    relativePath: string,
    value: unknown
  ): Promise<void> => this.writeText(
    relativePath,
    `${JSON.stringify(value, null, 2)}\n`
  );

  public readonly publish = async (): Promise<string> => {
    this.assertWritable();
    if (await exists(this.finalDirectory)) {
      throw new Error(
        `Artifact run directory already exists: ${this.finalDirectory}`
      );
    }
    await rename(this.temporaryDirectory, this.finalDirectory);
    this.published = true;
    return this.finalDirectory;
  };

  public readonly discard = async (): Promise<void> => {
    if (!this.published && !this.discarded) {
      await rm(this.temporaryDirectory, { recursive: true, force: true });
      this.discarded = true;
    }
  };

  private assertWritable(): void {
    if (this.published || this.discarded) {
      throw new Error("Artifact session is no longer writable");
    }
  }
}

export class FileSystemArtifactStore implements ArtifactStore {
  public readonly begin = async (
    baseDirectory: string,
    runDirectoryName: string
  ): Promise<ArtifactSession> => {
    assertRunDirectoryName(runDirectoryName);
    await mkdir(baseDirectory, { recursive: true });
    const temporaryDirectory = await mkdtemp(
      join(baseDirectory, `.${runDirectoryName}.tmp-`)
    );
    await mkdir(join(temporaryDirectory, "steps"), { recursive: true });
    return new FileSystemArtifactSession(
      temporaryDirectory,
      join(baseDirectory, runDirectoryName)
    );
  };
}
