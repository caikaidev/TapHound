import type {
  CachedFlowFragment,
  CachedScreenModel,
  FlowVerificationReceipt
} from "../domain/ui-cache.js";

export type UiCacheMissReason = "absent" | "corrupt" | "unknownSchema";

export type UiCacheReadResult<T> = {
  status: "hit";
  value: T;
} | {
  status: "miss";
  reason: UiCacheMissReason;
};

export interface UiCacheStatus {
  directory: string;
  entries: number;
  bytes: number;
}

export interface UiCacheStore {
  readScreen(key: string): Promise<UiCacheReadResult<CachedScreenModel>>;
  writeScreen(model: CachedScreenModel): Promise<string>;
  invalidateScreen(key: string): Promise<void>;
  readFlow(name: string): Promise<UiCacheReadResult<CachedFlowFragment>>;
  writeFlow(fragment: CachedFlowFragment): Promise<string>;
  addFlowVerification(
    name: string,
    receipt: FlowVerificationReceipt
  ): Promise<UiCacheReadResult<CachedFlowFragment>>;
  status(): Promise<UiCacheStatus>;
  clear(): Promise<void>;
}
