export interface ResolvedPath {
  configuredPath: string;
  resolvedPath: string;
}

export interface TargetPathResolverPort {
  resolve: (input: string, baseDir: string) => Promise<ResolvedPath>;
}