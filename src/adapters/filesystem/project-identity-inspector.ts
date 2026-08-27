import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  ProjectIdentityInspection,
  ProjectIdentityInspector
} from "../../ports/project-identity-inspector.js";
import { errnoCode } from "../../shared/errors.js";

const PACKAGE_PATTERN = /package\s*=\s*"([^"]+)"/;
const MAIN_ACTION = "android.intent.action.MAIN";
const LAUNCHER_CATEGORY = "android.intent.category.LAUNCHER";

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseApplicationIdLiteral(buildContent: string): string | undefined {
  const groovyMatch = buildContent.match(
    /applicationId\s+['"]([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)['"]/
  );
  if (groovyMatch !== null) {
    return groovyMatch[1];
  }
  const kotlinMatch = buildContent.match(
    /applicationId\s*=\s*['"]([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)['"]/
  );
  if (kotlinMatch !== null) {
    return kotlinMatch[1];
  }
  return undefined;
}

function parseApplicationIdVariable(buildContent: string): string | undefined {
  const varMatch = buildContent.match(
    /applicationId\s*=\s*([A-Za-z_$][\w$]*)[ \t]*(?:\/\/.*)?$/m
  );
  if (varMatch === null) {
    return undefined;
  }
  const variableName = varMatch[1];
  if (variableName === undefined) {
    return undefined;
  }
  const propPattern = new RegExp(
    `val\\s+${escapeRegExp(variableName)}\\s*=\\s*providers\\.gradleProperty\\s*\\(\\s*["']([^"']+)["']\\s*\\)\\.get\\(\\)`
  );
  const propMatch = buildContent.match(propPattern);
  return propMatch?.[1];
}

async function readGradleProperty(
  projectRoot: string,
  propertyName: string
): Promise<string | undefined> {
  const propertiesPath = resolve(projectRoot, "gradle.properties");
  let content: string;
  try {
    content = await readFile(propertiesPath, "utf8");
  } catch {
    return undefined;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("!")) {
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    if (key === propertyName) {
      return trimmed.slice(eqIndex + 1).trim();
    }
  }
  return undefined;
}

async function resolveApplicationId(
  buildContent: string | undefined,
  projectRoot: string
): Promise<{ applicationId: string | undefined; namespace: string | undefined }> {
  if (buildContent === undefined) {
    return { applicationId: undefined, namespace: undefined };
  }
  const literal = parseApplicationIdLiteral(buildContent);
  if (literal !== undefined) {
    const namespace = parseNamespace(buildContent);
    return { applicationId: literal, namespace };
  }
  const propertyName = parseApplicationIdVariable(buildContent);
  if (propertyName !== undefined) {
    const value = await readGradleProperty(projectRoot, propertyName);
    if (value !== undefined) {
      const namespace = parseNamespace(buildContent);
      return { applicationId: value, namespace };
    }
  }
  const namespace = parseNamespace(buildContent);
  return { applicationId: namespace, namespace };
}

function parseNamespace(buildContent: string): string | undefined {
  const namespaceMatch = buildContent.match(
    /namespace\s*=?\s*['"]([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)['"]/
  );
  return namespaceMatch?.[1];
}

function parseManifest(
  manifestContent: string
): { packageName: string | undefined; launchActivity: string | undefined } {
  const packageMatch = manifestContent.match(PACKAGE_PATTERN);
  const packageName = packageMatch?.[1];

  const activityBlocks: { name: string; filters: string[] }[] = [];
  const activityPattern = /<activity\b[^>]*>/g;
  let activityMatch: RegExpExecArray | null;
  while ((activityMatch = activityPattern.exec(manifestContent)) !== null) {
    const tag = activityMatch[0];
    const nameMatch = tag.match(/android:name\s*=\s*"([^"]+)"/);
    if (nameMatch === null) {
      continue;
    }
    const name = nameMatch[1];
    if (name === undefined) {
      continue;
    }

    const filters: string[] = [];
    if (!tag.endsWith("/>")) {
      const filterStart = activityMatch.index + tag.length;
      const closingIndex = manifestContent.indexOf("</activity>", filterStart);
      const activityBody = closingIndex === -1
        ? manifestContent.slice(filterStart)
        : manifestContent.slice(filterStart, closingIndex);

      const filterPattern = /<intent-filter\b[\s\S]*?<\/intent-filter>/g;
      let filterMatch: RegExpExecArray | null;
      while ((filterMatch = filterPattern.exec(activityBody)) !== null) {
        filters.push(filterMatch[0]);
      }
    }
    activityBlocks.push({ name, filters });
  }

  let launchActivity: string | undefined;
  for (const block of activityBlocks) {
    for (const filter of block.filters) {
      if (filter.includes(MAIN_ACTION) && filter.includes(LAUNCHER_CATEGORY)) {
        launchActivity = block.name;
        break;
      }
    }
    if (launchActivity !== undefined) {
      break;
    }
  }

  return { packageName, launchActivity };
}

function resolveActivity(
  packageName: string,
  activity: string
): string {
  if (activity.startsWith(".")) {
    return `${packageName}${activity}`;
  }
  if (!activity.includes(".")) {
    return `${packageName}.${activity}`;
  }
  return activity;
}

export class AndroidProjectIdentityInspector
implements ProjectIdentityInspector {
  public readonly inspectIdentity = async (input: {
    readonly projectRoot: string;
    readonly moduleDir: string;
  }): Promise<ProjectIdentityInspection> => {
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
        : { status: "identityNotFound", message: "Project root is not accessible" };
    }

    const modulePath = resolve(root, input.moduleDir);
    let moduleCanonical: string;
    try {
      moduleCanonical = await realpath(modulePath);
      const moduleStats = await stat(moduleCanonical);
      if (!moduleStats.isDirectory()) {
        return { status: "moduleNotFound" };
      }
    } catch (error) {
      return errnoCode(error) === "ENOENT"
        ? { status: "moduleNotFound" }
        : { status: "identityNotFound", message: "Module directory is not accessible" };
    }

    const buildContent = await readBuildFile(moduleCanonical);
    const { applicationId, namespace } = await resolveApplicationId(buildContent, root);

    const manifestPath = resolve(moduleCanonical, "src", "main", "AndroidManifest.xml");
    let manifestContent: string;
    try {
      manifestContent = await readFile(manifestPath, "utf8");
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {
        return { status: "manifestNotFound" };
      }
      return { status: "manifestUnreadable" };
    }

    const { packageName: manifestPackage, launchActivity } = parseManifest(manifestContent);
    const packageName = applicationId ?? manifestPackage;
    if (packageName === undefined) {
      return {
        status: "identityNotFound",
        message: "Unable to resolve applicationId or package from build file or manifest"
      };
    }
    if (launchActivity === undefined) {
      return {
        status: "identityNotFound",
        message: "Unable to resolve launch activity from manifest"
      };
    }

    const activityBase = namespace ?? manifestPackage ?? packageName;
    return {
      status: "inspected",
      packageName,
      launchActivity: resolveActivity(activityBase, launchActivity)
    };
  };
}
