import {
  DEFAULT_TARGET_ACTIVITY,
  DEFAULT_TARGET_IDLE,
  TargetError,
  type TargetEntry
} from "../../domain/target.js";
import { TapHoundConfigSchema, type TapHoundConfig } from "../../domain/config.js";
import type { ResolvedTarget } from "../../domain/target.js";
import type { LocalTargetServiceDependencies } from "./local-target-service-types.js";

export { type LocalTargetIdentityStore, type LocalTargetServiceDependencies } from "./local-target-service-types.js";

export class LocalTargetService {
  public constructor(
    private readonly dependencies: LocalTargetServiceDependencies
  ) {}

  public readonly configForTarget = (input: {
    entry: TargetEntry;
    resolvedPath: string;
    workspaceRoot: string;
  }): TapHoundConfig => {
    const run = input.entry.run as { packageName: string; activity?: string };
    return TapHoundConfigSchema.parse({
      version: 1,
      run: {
        packageName: run.packageName,
        activity: run.activity ?? DEFAULT_TARGET_ACTIVITY
      },
      idle: DEFAULT_TARGET_IDLE,
      artifactsDir: `${input.workspaceRoot}/runs`
    });
  };

  public readonly assertProjectUnchanged = async (
    target: ResolvedTarget,
    fingerprintHash: string
  ): Promise<void> => {
    const saved = await this.dependencies.identityStore.readIdentity(target.id);
    if (saved === null) {
      return;
    }
    if (saved.fingerprint.hash !== fingerprintHash) {
      throw new TargetError(
        "LOCAL_TARGET_PROJECT_CHANGED",
        `Target ${target.id} now resolves to a different project (fingerprint ${saved.fingerprint.hash} != ${fingerprintHash}). Re-register or point the path at the original repository.`
      );
    }
  };
}