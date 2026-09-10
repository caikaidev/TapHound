import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

import {
  LOCAL_WORKSPACE_DIR,
  LOCAL_WORKSPACE_IGNORE,
  TAPHOUND_DIR
} from "../../domain/workspace.js";
import {
  LocalTargetIdentitySchema,
  type LocalTargetIdentity
} from "../../domain/target.js";
import { isErrnoException } from "../../shared/errors.js";

const IDENTITY_PATH = "identity.json";

export interface LocalTargetWorkspacePort {
  root: (targetsHome: string, targetId: string) => string;
  identityPath: (targetsHome: string, targetId: string) => string;
  readIdentity: (targetsHome: string, targetId: string) => Promise<LocalTargetIdentity | null>;
  writeIdentity: (targetsHome: string, targetId: string, identity: LocalTargetIdentity) => Promise<void>;
  ensureWorkspace: (targetsHome: string, targetId: string) => Promise<void>;
  ensureTaphoundIgnored: (targetsHome: string) => Promise<void>;
}

export class FileSystemLocalTargetWorkspace implements LocalTargetWorkspacePort {
  public readonly root = (targetsHome: string, targetId: string): string =>
    join(targetsHome, LOCAL_WORKSPACE_DIR, targetId);

  public readonly identityPath = (targetsHome: string, targetId: string): string =>
    join(this.root(targetsHome, targetId), IDENTITY_PATH);

  public readonly readIdentity = async (
    targetsHome: string,
    targetId: string
  ): Promise<LocalTargetIdentity | null> => {
    try {
      const raw: unknown = JSON.parse(
        await readFile(this.identityPath(targetsHome, targetId), "utf8")
      );
      return LocalTargetIdentitySchema.parse(raw);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  };

  public readonly writeIdentity = async (
    targetsHome: string,
    targetId: string,
    identity: LocalTargetIdentity
  ): Promise<void> => {
    await this.ensureWorkspace(targetsHome, targetId);
    const path = this.identityPath(targetsHome, targetId);
    const temporary = `${path}.tmp-${String(process.pid)}`;
    await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  };

  public readonly ensureWorkspace = async (
    targetsHome: string,
    targetId: string
  ): Promise<void> => {
    await this.ensureTaphoundIgnored(targetsHome);
    await mkdir(join(this.root(targetsHome, targetId), "context"), { recursive: true });
    await mkdir(join(this.root(targetsHome, targetId), "journeys"), { recursive: true });
    await mkdir(join(this.root(targetsHome, targetId), "runs"), { recursive: true });
    await mkdir(join(this.root(targetsHome, targetId), "generations"), { recursive: true });
    await mkdir(join(this.root(targetsHome, targetId), "cache"), { recursive: true });
  };

  public readonly ensureTaphoundIgnored = async (targetsHome: string): Promise<void> => {
    const taphoundDir = join(targetsHome, TAPHOUND_DIR);
    const ignorePath = join(targetsHome, TAPHOUND_DIR, ".gitignore");
    await mkdir(taphoundDir, { recursive: true });
    let existing: string;
    try {
      existing = await readFile(ignorePath, "utf8");
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") {
        throw error;
      }
      await writeFile(ignorePath, LOCAL_WORKSPACE_IGNORE, "utf8");
      return;
    }
    const lines = existing.split("\n");
    if (lines.includes("local/")) {
      return;
    }
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    await writeFile(
      ignorePath,
      `${existing}${separator}${LOCAL_WORKSPACE_IGNORE}`,
      "utf8"
    );
  };
}