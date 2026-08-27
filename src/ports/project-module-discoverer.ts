export interface DiscoveredModule {
  readonly id: string;
  readonly projectDir: string;
  readonly kind: "application" | "feature" | "library";
  readonly dependsOn: readonly string[];
}

export type ProjectModuleDiscovery =
  | { readonly status: "discovered"; readonly modules: readonly DiscoveredModule[] }
  | { readonly status: "rootNotFound" }
  | { readonly status: "rootNotDirectory" }
  | { readonly status: "noSettingsFile" }
  | { readonly status: "noApplicationModule" }
  | { readonly status: "discoveryFailed"; readonly message: string };

export interface ProjectModuleDiscoverer {
  discoverModules: (input: {
    readonly projectRoot: string;
  }) => Promise<ProjectModuleDiscovery>;
}
