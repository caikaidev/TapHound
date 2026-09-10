import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  TargetEntrySchema,
  TargetsFileSchema,
  TargetError,
  type TargetEntry,
  type TargetsFile
} from "../../domain/target.js";
import {
  TARGETS_LOCAL_CONFIG_PATH,
  TARGETS_CONFIG_PATH
} from "../../domain/workspace.js";
import type {
  LoadedTargets,
  RegisterTargetInput,
  TargetConfigStorePort
} from "../../ports/target-config-store.js";
import { isErrnoException } from "../../shared/errors.js";

async function readOptionalJson(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new TargetError(
      "TARGET_CONFIG_INVALID",
      `Invalid JSON in ${path}: ${(error as Error).message}`
    );
  }
}

function parsedTargetsFile(raw: unknown, path: string): TargetsFile | undefined {
  if (raw === undefined) {
    return undefined;
  }
  try {
    return TargetsFileSchema.parse(raw);
  } catch (error) {
    throw new TargetError(
      "TARGET_CONFIG_INVALID",
      `Invalid target configuration in ${path}: ${(error as Error).message}`
    );
  }
}

export class FileSystemTargetConfigStore implements TargetConfigStorePort {
  public readonly loadTargets = async (
    targetsHome: string
  ): Promise<LoadedTargets> => {
    const official = parsedTargetsFile(
      await readOptionalJson(join(targetsHome, TARGETS_CONFIG_PATH)),
      TARGETS_CONFIG_PATH
    );
    const local = parsedTargetsFile(
      await readOptionalJson(join(targetsHome, TARGETS_LOCAL_CONFIG_PATH)),
      TARGETS_LOCAL_CONFIG_PATH
    );
    const targets: Record<string, TargetEntry & { id: string }> = {};
    for (const [id, entry] of Object.entries(official?.targets ?? {})) {
      targets[id] = { ...entry, id };
    }
    for (const [id, entry] of Object.entries(local?.targets ?? {})) {
      if (targets[id] !== undefined && !entry.override) {
        throw new TargetError(
          "TARGET_ID_CONFLICT",
          `Target id "${id}" exists in both ${TARGETS_CONFIG_PATH} and ${TARGETS_LOCAL_CONFIG_PATH}. Set "override": true in the local entry to replace it.`
        );
      }
      targets[id] = {
        ...entry,
        override: false,
        id
      };
    }
    return { targets, official, local };
  };

  public readonly appendLocalTarget = async (
    targetsHome: string,
    id: string,
    entry: RegisterTargetInput
  ): Promise<void> => {
    const path = join(targetsHome, TARGETS_LOCAL_CONFIG_PATH);
    await mkdir(dirname(path), { recursive: true });
    const current = parsedTargetsFile(
      await readOptionalJson(path),
      TARGETS_LOCAL_CONFIG_PATH
    ) ?? { version: 1 as const, targets: {} };
    const next = TargetEntrySchema.parse({ ...entry, override: false });
    const updated: TargetsFile = {
      version: 1,
      targets: { ...current.targets, [id]: next }
    };
    const temporary = `${path}.tmp-${process.pid.toString()}`;
    await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  };

  public readonly removeLocalTarget = async (
    targetsHome: string,
    id: string
  ): Promise<boolean> => {
    const path = join(targetsHome, TARGETS_LOCAL_CONFIG_PATH);
    const current = parsedTargetsFile(await readOptionalJson(path), TARGETS_LOCAL_CONFIG_PATH);
    if (current === undefined || current.targets[id] === undefined) {
      return false;
    }
    const targets: Record<string, TargetEntry> = {};
    for (const [key, value] of Object.entries(current.targets)) {
      if (key !== id) targets[key] = value;
    }
    const temporary = `${path}.tmp-${process.pid.toString()}`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, targets }, null, 2)}\n`, "utf8");
    await rename(temporary, path);
    return true;
  };
}