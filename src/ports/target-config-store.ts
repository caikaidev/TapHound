import type {
  TargetEntry,
  TargetsFile
} from "../domain/target.js";

export interface LoadedTargetEntry extends TargetEntry {
  readonly id: string;
}

export interface LoadedTargets {
  targets: Record<string, LoadedTargetEntry>;
  official: TargetsFile | undefined;
  local: TargetsFile | undefined;
}

export type RegisterTargetInput = Pick<TargetEntry, "source" | "run">;

export interface TargetConfigStorePort {
  loadTargets: (targetsHome: string) => Promise<LoadedTargets>;
  appendLocalTarget: (
    targetsHome: string,
    id: string,
    entry: RegisterTargetInput
  ) => Promise<void>;
  removeLocalTarget: (targetsHome: string, id: string) => Promise<boolean>;
}