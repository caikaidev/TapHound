import { createHash } from "node:crypto";

import type { ExternalFlow } from "../../domain/external-flow.js";
import type {
  ExternalFlowCatalogEntry,
  ExternalFlowRecord
} from "../../ports/external-flow-registry.js";

export interface ExternalFlowResolution {
  flow: ExternalFlow;
  flowSha256: string;
  stepCount: number;
}

export interface ExternalFlowResolverDependencies {
  registry: {
    read: (input: {
      projectRoot: string;
      name: string;
    }) => Promise<ExternalFlowRecord>;
    list: (projectRoot: string) => Promise<readonly ExternalFlowCatalogEntry[]>;
  };
}

export class ExternalFlowResolver {
  public constructor(
    private readonly dependencies: ExternalFlowResolverDependencies
  ) {}

  public readonly resolve = async (input: {
    projectRoot: string;
    name: string;
  }): Promise<ExternalFlowResolution> => {
    const record = await this.dependencies.registry.read(input);
    if (record.flow.includes.length > 0) {
      throw new Error(
        `External Flow "${input.name}" uses includes, which are not supported in v1`
      );
    }
    return {
      flow: record.flow,
      flowSha256: sha256(record.bytes),
      stepCount: record.flow.steps.length
    };
  };

  public readonly list = async (
    projectRoot: string
  ): Promise<readonly ExternalFlowCatalogEntry[]> =>
    this.dependencies.registry.list(projectRoot);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
