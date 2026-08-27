export type ProjectIdentityInspection =
  | {
      readonly status: "inspected";
      readonly packageName: string;
      readonly launchActivity: string;
    }
  | { readonly status: "rootNotFound" }
  | { readonly status: "rootNotDirectory" }
  | { readonly status: "moduleNotFound" }
  | { readonly status: "manifestNotFound" }
  | { readonly status: "manifestUnreadable" }
  | { readonly status: "identityNotFound"; readonly message: string };

export interface ProjectIdentityInspector {
  inspectIdentity: (input: {
    readonly projectRoot: string;
    readonly moduleDir: string;
  }) => Promise<ProjectIdentityInspection>;
}
