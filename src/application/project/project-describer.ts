import { normalizeActivity } from "../../domain/activity.js";
import type { TapHoundConfig } from "../../domain/config.js";
import type { AndroidCliPort } from "../../ports/android-cli.js";

export class ProjectConfigurationError extends Error {
  public override readonly name = "ProjectConfigurationError";
}

export interface ProjectDescribeInput {
  projectRoot: string;
  config: TapHoundConfig;
  signal?: AbortSignal | undefined;
}

export interface ProjectDescription {
  projectRoot: string;
  packageName: string;
  buildTask: string;
  artifactTarget: string;
  variant: string;
  launchActivity: string;
  apkPath: string;
  metadataPaths: readonly string[];
  metadataPackageName?: string | undefined;
}

export class ProjectDescriber {
  public constructor(private readonly androidCli: AndroidCliPort) {}

  public readonly describe = async (
    input: ProjectDescribeInput
  ): Promise<ProjectDescription> => {
    const description = await this.androidCli.describeProject({
      projectDir: input.projectRoot,
      target: input.config.artifact.target,
      variant: input.config.artifact.variant,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    if (
      description.packageName !== undefined
      && description.packageName !== input.config.run.packageName
    ) {
      throw new ProjectConfigurationError(
        `Configured Package ${input.config.run.packageName} conflicts with Android metadata ${description.packageName}`
      );
    }

    return {
      projectRoot: input.projectRoot,
      packageName: input.config.run.packageName,
      buildTask: input.config.build.task,
      artifactTarget: input.config.artifact.target,
      variant: input.config.artifact.variant,
      launchActivity: normalizeActivity(
        input.config.run.packageName,
        input.config.run.activity
      ),
      apkPath: description.apkPath,
      metadataPaths: description.metadataPaths,
      ...(description.packageName === undefined
        ? {}
        : { metadataPackageName: description.packageName })
    };
  };
}
