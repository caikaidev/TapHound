import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  DiscoveredModule,
  ProjectModuleDiscovery,
  ProjectModuleDiscoverer
} from "../../ports/project-module-discoverer.js";
import { errnoCode } from "../../shared/errors.js";

const GRADLE_PATH = "(:[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*)";

const QUOTED_PATH = new RegExp(`['"]${GRADLE_PATH}['"]`, "g");

const PAIR_PATTERN = new RegExp(
  `['"]${GRADLE_PATH}['"]\\s+to\\s+['"]([^'"]+)['"]`,
  "g"
);

const PROJECT_DIR_OVERRIDE = new RegExp(
  `project\\s*\\(\\s*['"]${GRADLE_PATH}['"]\\s*\\)\\s*\\.\\s*projectDir\\s*=\\s*(?:file|new\\s+File)\\s*\\(\\s*(?:rootDir\\s*,\\s*)?['"]([^'"]+)['"]\\s*\\)`,
  "g"
);

function gradlePathToProjectDir(gradlePath: string): string {
  return gradlePath.replace(/^:/, "").replace(/:/g, "/");
}

function stripRootDirPrefix(dir: string): string {
  return dir.replace(/^\$\{?rootDir\}?\/+/, "");
}

interface IncludedModule {
  readonly gradlePath: string;
  readonly explicitDir?: string;
}

function parseIncludedModules(content: string): IncludedModule[] {
  const moduleMap = new Map<string, string | undefined>();

  QUOTED_PATH.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QUOTED_PATH.exec(content)) !== null) {
    const gradlePath = match[1];
    if (gradlePath !== undefined) {
      moduleMap.set(gradlePath, undefined);
    }
  }

  PAIR_PATTERN.lastIndex = 0;
  while ((match = PAIR_PATTERN.exec(content)) !== null) {
    const gradlePath = match[1];
    const dir = match[2];
    if (gradlePath !== undefined && dir !== undefined) {
      moduleMap.set(gradlePath, stripRootDirPrefix(dir));
    }
  }

  PROJECT_DIR_OVERRIDE.lastIndex = 0;
  while ((match = PROJECT_DIR_OVERRIDE.exec(content)) !== null) {
    const gradlePath = match[1];
    const dir = match[2];
    if (gradlePath !== undefined && dir !== undefined) {
      moduleMap.set(gradlePath, stripRootDirPrefix(dir));
    }
  }

  return [...moduleMap.entries()].map(([gradlePath, explicitDir]) => ({
    gradlePath,
    ...(explicitDir === undefined ? {} : { explicitDir })
  }));
}

async function findSettingsFile(
  projectRoot: string
): Promise<string | undefined> {
  for (const name of ["settings.gradle.kts", "settings.gradle"]) {
    const candidate = resolve(projectRoot, name);
    try {
      const stats = await stat(candidate);
      if (stats.isFile()) {
        return candidate;
      }
    } catch {
      // continue
    }
  }
  return undefined;
}

async function readBuildFile(
  moduleDir: string
): Promise<string | undefined> {
  for (const name of ["build.gradle.kts", "build.gradle"]) {
    const candidate = resolve(moduleDir, name);
    try {
      const stats = await stat(candidate);
      if (stats.isFile()) {
        return await readFile(candidate, "utf8");
      }
    } catch {
      // continue
    }
  }
  return undefined;
}

function detectKind(buildContent: string): "application" | "feature" | "library" {
  if (
    /com\.android\.application/.test(buildContent)
    || /id\s*\(\s*["'][^"']*android\.application[^"']*["']\s*\)/.test(buildContent)
    || /apply\s*\(\s*plugin\s*=\s*["'][^"']*android\.application[^"']*["']\s*\)/.test(buildContent)
    || /alias\s*\([^)]*android\.application[^)]*\)/.test(buildContent)
  ) {
    return "application";
  }
  if (
    /com\.android\.dynamic-feature/.test(buildContent)
    || /id\s*\(\s*["'][^"']*android\.dynamic-feature[^"']*["']\s*\)/.test(buildContent)
    || /alias\s*\([^)]*android\.dynamic-feature[^)]*\)/.test(buildContent)
  ) {
    return "feature";
  }
  return "library";
}

function parseDependencies(buildContent: string): string[] {
  const deps: string[] = [];
  const pattern = new RegExp(
    `project\\s*\\(\\s*['"]${GRADLE_PATH}['"]\\s*\\)`,
    "g"
  );
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(buildContent)) !== null) {
    const dep = match[1];
    if (dep !== undefined) {
      deps.push(dep);
    }
  }
  return [...new Set(deps)];
}

export class GradleProjectModuleDiscoverer
implements ProjectModuleDiscoverer {
  public readonly discoverModules = async (input: {
    readonly projectRoot: string;
  }): Promise<ProjectModuleDiscovery> => {
    let root: string;
    try {
      root = await realpath(input.projectRoot);
      const rootStats = await stat(root);
      if (!rootStats.isDirectory()) {
        return { status: "rootNotDirectory" };
      }
    } catch (error) {
      return errnoCode(error) === "ENOENT"
        ? { status: "rootNotFound" }
        : { status: "discoveryFailed", message: "Project root is not accessible" };
    }

    const settingsPath = await findSettingsFile(root);
    if (settingsPath === undefined) {
      return { status: "noSettingsFile" };
    }

    let settingsContent: string;
    try {
      settingsContent = await readFile(settingsPath, "utf8");
    } catch {
      return { status: "discoveryFailed", message: "settings file is not readable" };
    }

    const includedModules = parseIncludedModules(settingsContent);
    if (includedModules.length === 0) {
      return { status: "noApplicationModule" };
    }

    const modules: DiscoveredModule[] = [];
    for (const { gradlePath, explicitDir } of includedModules) {
      const projectDir = explicitDir ?? gradlePathToProjectDir(gradlePath);
      const moduleDir = resolve(root, projectDir);
      try {
        const moduleStats = await stat(moduleDir);
        if (!moduleStats.isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }
      const buildContent = await readBuildFile(moduleDir);
      const kind = buildContent !== undefined
        ? detectKind(buildContent)
        : "library";
      const dependsOn = buildContent !== undefined
        ? parseDependencies(buildContent)
        : [];
      modules.push({ id: gradlePath, projectDir, kind, dependsOn });
    }

    if (!modules.some((module) => module.kind === "application")) {
      return { status: "noApplicationModule" };
    }

    return { status: "discovered", modules };
  };
}
