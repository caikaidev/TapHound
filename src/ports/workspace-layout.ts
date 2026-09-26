export interface WorkspaceLayoutPort {
  ensureBuildIgnored: (projectRoot: string) => Promise<void>;
  ensureBuildLayout: (projectRoot: string) => Promise<void>;
}
