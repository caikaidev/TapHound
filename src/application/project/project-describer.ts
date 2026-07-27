import { normalizeActivity } from "../../domain/activity.js";
import type { TapHoundConfig } from "../../domain/config.js";

export interface ProjectDescribeInput {
  projectRoot: string;
  config: TapHoundConfig;
  signal?: AbortSignal | undefined;
}

export interface ProjectDescription {
  projectRoot: string;
  packageName: string;
  launchActivity: string;
}

export class ProjectDescriber {
  public readonly describe = async (
    input: ProjectDescribeInput
  ): Promise<ProjectDescription> => Promise.resolve({
    projectRoot: input.projectRoot,
    packageName: input.config.run.packageName,
    launchActivity: normalizeActivity(
      input.config.run.packageName,
      input.config.run.activity
    )
  });
}
