export type ProjectInventoryCategory =
  | "manifests"
  | "sources"
  | "layouts"
  | "navigation";

export type ProjectInventoryInspection =
  | { status: "rootNotFound" }
  | { status: "rootUnreadable" }
  | { status: "rootNotDirectory" }
  | { status: "escape" }
  | {
      status: "inspected";
      paths: string[];
      pathSetSha256: string;
    };

export interface ProjectInventoryInspector {
  inspectProjectInventory: (input: {
    projectRoot: string;
    projectDir: string;
    categories: ProjectInventoryCategory[];
  }) => Promise<ProjectInventoryInspection>;
}
