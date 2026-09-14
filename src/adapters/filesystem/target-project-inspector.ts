import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  TargetProjectInspection,
  TargetProjectInspectorPort
} from "../../ports/target-project-inspector.js";
import { hasModuleBuildFile } from "./android-project-detection.js";

async function firstExisting(
  root: string,
  candidates: readonly string[]
): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await access(join(root, candidate));
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function rootProjectName(root: string): Promise<string | undefined> {
  for (const file of ["settings.gradle.kts", "settings.gradle"]) {
    try {
      const content = await readFile(join(root, file), "utf8");
      const match = /rootProject\.name\s*=\s*["']([^"']+)["']/.exec(content);
      if (match !== null) {
        return match[1];
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export class NodeTargetProjectInspector implements TargetProjectInspectorPort {
  public readonly inspect = async (
    root: string
  ): Promise<TargetProjectInspection> => {
    const settingsFile = await firstExisting(root, [
      "settings.gradle.kts",
      "settings.gradle"
    ]);
    const wrapper = await Promise.all([
      firstExisting(root, ["gradlew"]),
      firstExisting(root, ["gradle/wrapper/gradle-wrapper.properties"])
    ]);
    let settingsSha256: string | undefined;
    if (settingsFile !== undefined) {
      try {
        settingsSha256 = createHash("sha256")
          .update(await readFile(join(root, settingsFile), "utf8"))
          .digest("hex");
      } catch {
        settingsSha256 = undefined;
      }
    }
    const projectName = await rootProjectName(root);
    return {
      ...(settingsFile === undefined ? {} : { settingsFile }),
      hasWrapperEntry: wrapper.some((entry) => entry !== undefined),
      hasWrapperProperties: wrapper[1] !== undefined,
      hasModuleBuildFile: await hasModuleBuildFile(root),
      ...(projectName === undefined
        ? {}
        : { rootProjectName: projectName }),
      ...(settingsSha256 === undefined ? {} : { settingsSha256 })
    };
  };
}
