export interface LocalAssetSyncResult {
  syncedDirs: string[];
  filesCopied: number;
}

export interface LocalAssetSyncPort {
  sync: (input: {
    projectRoot: string;
    workspaceRoot: string;
    assetDirectories: readonly string[];
  }) => Promise<LocalAssetSyncResult>;
}
