import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { isErrnoException } from "../../shared/errors.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function hasModuleBuildFile(root: string): Promise<boolean> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (
      await pathExists(join(root, entry.name, "build.gradle"))
      || await pathExists(join(root, entry.name, "build.gradle.kts"))
    ) {
      return true;
    }
  }
  return false;
}

export async function hasAndroidProjectStructure(root: string): Promise<boolean> {
  const settings = await Promise.all([
    pathExists(join(root, "settings.gradle")),
    pathExists(join(root, "settings.gradle.kts"))
  ]);
  if (!(settings[0] || settings[1])) {
    return false;
  }
  const wrapper = await Promise.all([
    pathExists(join(root, "gradlew")),
    pathExists(join(root, "gradle", "wrapper", "gradle-wrapper.properties"))
  ]);
  if (wrapper[0] || wrapper[1]) {
    return true;
  }
  return hasModuleBuildFile(root);
}