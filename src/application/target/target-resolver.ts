import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  AndroidProjectIdentitySchema,
  ProjectFingerprintSchema,
  ResolvedTargetSchema,
  TargetError,
  type AndroidProjectIdentity,
  type ProjectFingerprint,
  type ResolvedTarget
} from "../../domain/target.js";
import { localTargetWorkspaceRoot } from "../../domain/workspace.js";
import { hasModuleBuildFile } from "../../adapters/filesystem/android-project-detection.js";
import type {
  LoadedTargets,
  TargetConfigStorePort
} from "../../ports/target-config-store.js";
import type { ResolvedPath, TargetPathResolverPort } from "../../ports/path-resolver.js";
import type { ProcessRunner } from "../../ports/process-runner.js";

export interface TargetResolverDependencies {
  targetsHome: string;
  configStore: TargetConfigStorePort;
  pathResolver: TargetPathResolverPort;
  processRunner: ProcessRunner;
  clock: { now: () => Date };
}

async function gitValue(
  runner: ProcessRunner,
  root: string,
  args: readonly string[]
): Promise<string | undefined> {
  const result = await runner.run({
    executable: "git",
    args: ["-C", root, ...args]
  });
  if (result.exitCode !== 0) {
    return undefined;
  }
  const value = result.stdout.trim();
  return value.length === 0 ? undefined : value;
}

export class TargetResolver {
  public constructor(
    private readonly dependencies: TargetResolverDependencies
  ) {}

  public readonly resolve = async (id: string): Promise<ResolvedTarget> => {
    const loaded: LoadedTargets = await this.dependencies.configStore.loadTargets(
      this.dependencies.targetsHome
    );
    const entry = loaded.targets[id];
    if (entry === undefined) {
      throw new TargetError(
        "LOCAL_TARGET_NOT_FOUND",
        `Local target "${id}" is not registered. Add it with: taphound local add ${id} --path <path>`
      );
    }
    return this.resolvePath(id, entry.source.path);
  };

  public readonly resolveByPath = async (input: string): Promise<ResolvedTarget> => {
    const id = `path-${createHash("sha256").update(input).digest("hex").slice(0, 12)}`;
    return this.resolvePath(id, input);
  };

  private readonly resolvePath = async (
    id: string,
    configuredPath: string
  ): Promise<ResolvedTarget> => {
    const resolved: ResolvedPath = await this.dependencies.pathResolver.resolve(
      configuredPath,
      this.dependencies.targetsHome
    );
    const project = await this.detectAndroidProject(resolved.resolvedPath);
    return ResolvedTargetSchema.parse({
      id,
      sourceType: "local",
      configuredPath: resolved.configuredPath,
      resolvedPath: resolved.resolvedPath,
      project,
      workspaceRoot: localTargetWorkspaceRoot(this.dependencies.targetsHome, id)
    });
  };

  private readonly detectAndroidProject = async (
    root: string
  ): Promise<AndroidProjectIdentity> => {
    const runner = this.dependencies.processRunner;
    const gitRoot = await gitValue(runner, root, ["rev-parse", "--show-toplevel"]);
    const settingsFile = await this.firstExisting(root, [
      "settings.gradle.kts",
      "settings.gradle"
    ]);
    if (settingsFile === undefined) {
      throw new TargetError(
        "LOCAL_TARGET_NOT_ANDROID_PROJECT",
        `No settings.gradle(.kts) found at ${root}`
      );
    }
    const hasWrapperEntry = await this.hasPath(root, [
      "gradlew",
      "gradle/wrapper/gradle-wrapper.properties"
    ]);
    if (!hasWrapperEntry && !(await hasModuleBuildFile(root))) {
      throw new TargetError(
        "LOCAL_TARGET_NOT_ANDROID_PROJECT",
        `No Gradle wrapper or module build file found at ${root}`
      );
    }
    const hasWrapperProperties = await this.hasPath(root, [
      "gradle/wrapper/gradle-wrapper.properties"
    ]);
    return AndroidProjectIdentitySchema.parse({
      rootDir: root,
      settingsFile,
      ...(hasWrapperProperties
        ? { gradleWrapper: "gradle/wrapper/gradle-wrapper.properties" }
        : {}),
      ...(gitRoot === undefined ? {} : { gitRoot })
    });
  };

  private readonly firstExisting = async (
    root: string,
    candidates: readonly string[]
  ): Promise<string | undefined> => {
    for (const candidate of candidates) {
      try {
        await access(join(root, candidate));
        return candidate;
      } catch {
        continue;
      }
    }
    return undefined;
  };

  private readonly hasPath = async (
    root: string,
    candidates: readonly string[]
  ): Promise<boolean> => (await this.firstExisting(root, candidates)) !== undefined;

  public readonly fingerprint = async (
    project: AndroidProjectIdentity,
    packageName: string | undefined
  ): Promise<ProjectFingerprint> => {
    const runner = this.dependencies.processRunner;
    const root = project.rootDir;
    const [remote, head] = await Promise.all([
      gitValue(runner, root, ["config", "--get", "remote.origin.url"]),
      gitValue(runner, root, ["rev-parse", "HEAD"])
    ]);
    const rootProjectName = await this.rootProjectName(root);
    const settingsHash = await this.fileHash(root, project.settingsFile);
    const parts = [
      remote === undefined ? "no-remote" : remote,
      rootProjectName === undefined ? "no-name" : rootProjectName,
      settingsHash === undefined ? "no-settings-hash" : settingsHash,
      head === undefined ? "no-head" : head,
      packageName === undefined ? "no-package" : packageName
    ];
    const hash = createHash("sha256").update(parts.join("\n")).digest("hex");
    return ProjectFingerprintSchema.parse({
      schemaVersion: 1,
      hash,
      ...(remote === undefined ? {} : { gitRemote: remote }),
      ...(rootProjectName === undefined ? {} : { rootProjectName }),
      ...(packageName === undefined ? {} : { packageName })
    });
  };

  private readonly rootProjectName = async (
    root: string
  ): Promise<string | undefined> => {
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
  };

  private readonly fileHash = async (
    root: string,
    file: string
  ): Promise<string | undefined> => {
    try {
      return createHash("sha256").update(await readFile(join(root, file), "utf8")).digest("hex");
    } catch {
      return undefined;
    }
  };
}