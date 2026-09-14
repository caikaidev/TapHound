import { createHash } from "node:crypto";

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
import type {
  LoadedTargets,
  TargetConfigStorePort
} from "../../ports/target-config-store.js";
import type { ResolvedPath, TargetPathResolverPort } from "../../ports/path-resolver.js";
import type { ProcessRunner } from "../../ports/process-runner.js";
import type {
  TargetProjectInspectorPort
} from "../../ports/target-project-inspector.js";

export interface TargetResolverDependencies {
  targetsHome: string;
  configStore: TargetConfigStorePort;
  pathResolver: TargetPathResolverPort;
  processRunner: ProcessRunner;
  projectInspector: TargetProjectInspectorPort;
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
    const inspection = await this.dependencies.projectInspector.inspect(root);
    if (inspection.settingsFile === undefined) {
      throw new TargetError(
        "LOCAL_TARGET_NOT_ANDROID_PROJECT",
        `No settings.gradle(.kts) found at ${root}`
      );
    }
    if (!inspection.hasWrapperEntry && !inspection.hasModuleBuildFile) {
      throw new TargetError(
        "LOCAL_TARGET_NOT_ANDROID_PROJECT",
        `No Gradle wrapper or module build file found at ${root}`
      );
    }
    return AndroidProjectIdentitySchema.parse({
      rootDir: root,
      settingsFile: inspection.settingsFile,
      ...(inspection.hasWrapperProperties
        ? { gradleWrapper: "gradle/wrapper/gradle-wrapper.properties" }
        : {}),
      ...(gitRoot === undefined ? {} : { gitRoot })
    });
  };

  public readonly fingerprint = async (
    project: AndroidProjectIdentity,
    packageName: string | undefined
  ): Promise<ProjectFingerprint> => {
    const runner = this.dependencies.processRunner;
    const root = project.rootDir;
    const remote = await gitValue(runner, root, ["config", "--get", "remote.origin.url"]);
    const inspection = await this.dependencies.projectInspector.inspect(root);
    const rootProjectName = inspection.rootProjectName;
    const settingsHash = inspection.settingsSha256;
    const parts = [
      remote === undefined ? "no-remote" : remote,
      rootProjectName === undefined ? "no-name" : rootProjectName,
      settingsHash === undefined ? "no-settings-hash" : settingsHash,
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

}