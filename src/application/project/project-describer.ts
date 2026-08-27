import { normalizeActivity } from "../../domain/activity.js";
import type { TapHoundConfig } from "../../domain/config.js";
import type {
  ProjectIdentityInspector
} from "../../ports/project-identity-inspector.js";
import type {
  ProjectModuleDiscoverer
} from "../../ports/project-module-discoverer.js";

export interface ProjectDescribeInput {
  readonly projectRoot: string;
  readonly config: TapHoundConfig;
  readonly signal?: AbortSignal | undefined;
}

export interface ProjectDescription {
  readonly projectRoot: string;
  readonly packageName: string;
  readonly launchActivity: string;
}

export interface ProjectDescriberDependencies {
  readonly discoverer?: ProjectModuleDiscoverer | undefined;
  readonly identity?: ProjectIdentityInspector | undefined;
}

export class ProjectDescriber {
  public constructor(
    private readonly dependencies: ProjectDescriberDependencies = {}
  ) {}

  public readonly describe = async (
    input: ProjectDescribeInput
  ): Promise<ProjectDescription> => {
    const { discoverer, identity } = this.dependencies;
    if (discoverer !== undefined && identity !== undefined) {
      try {
        const discovery = await discoverer.discoverModules({
          projectRoot: input.projectRoot
        });
        if (discovery.status === "discovered") {
          const appModule = discovery.modules.find(
            (module) => module.kind === "application"
          );
          if (appModule !== undefined) {
            const inspected = await identity.inspectIdentity({
              projectRoot: input.projectRoot,
              moduleDir: appModule.projectDir
            });
            if (inspected.status === "inspected") {
              return {
                projectRoot: input.projectRoot,
                packageName: inspected.packageName,
                launchActivity: inspected.launchActivity
              };
            }
          }
        }
      } catch {
        // fall back to config values
      }
    }
    return {
      projectRoot: input.projectRoot,
      packageName: input.config.run.packageName,
      launchActivity: normalizeActivity(
        input.config.run.packageName,
        input.config.run.activity
      )
    };
  };
}
