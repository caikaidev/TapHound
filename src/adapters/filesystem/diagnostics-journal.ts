import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import {
  CommandEventSchema,
  DIAGNOSTICS_EVENTS_FILE,
  DIAGNOSTICS_EVENTS_ROTATED_FILE,
  DIAGNOSTICS_SALT_FILE,
  type CommandEvent
} from "../../domain/diagnostics.js";
import {
  BUILD_DIR,
  BUILD_IGNORE_FILE,
  DIAGNOSTICS_LOG_DIR,
  TAPHOUND_DIR
} from "../../domain/workspace.js";
import type { DiagnosticsJournal } from "../../ports/diagnostics.js";
import { ensureBuildLayout } from "./workspace-layout.js";

const DEFAULT_MAX_BYTES = 1024 * 1024;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await lstat(path)).size;
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return "";
    throw error;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/**
 * Appends one JSON line per invocation under `.taphound/build/log/`. It only
 * writes where a command already initialized the ignored build layout (the
 * build directory and `.taphound/.gitignore`), so read-only commands never
 * create project files, and keeps the current file under `maxBytes` with one
 * rotated predecessor.
 */
export class FileSystemDiagnosticsJournal implements DiagnosticsJournal {
  public constructor(private readonly maxBytes = DEFAULT_MAX_BYTES) {}

  public async append(projectRoot: string, event: CommandEvent): Promise<void> {
    if (
      !await isDirectory(join(projectRoot, BUILD_DIR))
      || !await isFile(join(projectRoot, BUILD_IGNORE_FILE))
    ) {
      return;
    }
    const line = `${JSON.stringify(CommandEventSchema.parse(event))}\n`;
    const directory = await this.ensureLogDirectory(projectRoot);
    const current = join(directory, DIAGNOSTICS_EVENTS_FILE);
    if (await sizeOf(current) + Buffer.byteLength(line) > this.maxBytes) {
      await rename(current, join(directory, DIAGNOSTICS_EVENTS_ROTATED_FILE))
        .catch((error: unknown) => {
          if (!isMissing(error)) throw error;
        });
    }
    const handle = await open(
      current,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await handle.writeFile(line, "utf8");
    } finally {
      await handle.close();
    }
  }

  public async readLines(projectRoot: string): Promise<readonly string[]> {
    const directory = join(projectRoot, DIAGNOSTICS_LOG_DIR);
    const text = await readOptional(join(directory, DIAGNOSTICS_EVENTS_ROTATED_FILE))
      + await readOptional(join(directory, DIAGNOSTICS_EVENTS_FILE));
    return text.split("\n").filter((line) => line.trim().length > 0);
  }

  public async salt(projectRoot: string): Promise<Buffer> {
    if (!await isDirectory(join(projectRoot, TAPHOUND_DIR))) {
      throw Object.assign(
        new Error(`Not a TapHound project (no ${TAPHOUND_DIR}/ directory): ${projectRoot}`),
        { code: "CONFIG_INVALID" }
      );
    }
    await ensureBuildLayout(projectRoot);
    const path = join(await this.ensureLogDirectory(projectRoot), DIAGNOSTICS_SALT_FILE);
    try {
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      const salt = randomBytes(32);
      try {
        await handle.writeFile(salt);
      } finally {
        await handle.close();
      }
      return salt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const salt = await readFile(path);
    if (salt.length < 16) {
      throw new Error(`Diagnostics salt is unreadable: ${DIAGNOSTICS_LOG_DIR}/${DIAGNOSTICS_SALT_FILE}`);
    }
    return salt;
  }

  private async ensureLogDirectory(projectRoot: string): Promise<string> {
    const directory = join(projectRoot, DIAGNOSTICS_LOG_DIR);
    await mkdir(directory, { recursive: true });
    if (!await isDirectory(directory)) {
      throw new Error(`${DIAGNOSTICS_LOG_DIR} is not a directory`);
    }
    return directory;
  }
}
