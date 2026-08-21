export interface WorkspaceLayoutPort {
  findLegacyDirectories: (projectRoot: string) => Promise<readonly string[]>;
  ensureBuildIgnored: (projectRoot: string) => Promise<void>;
  ensureBuildLayout: (projectRoot: string) => Promise<void>;
}
