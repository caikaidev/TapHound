export type ProjectFileInspection =
  | { status: "rootNotFound" }
  | { status: "rootUnreadable" }
  | { status: "rootNotDirectory" }
  | { status: "notFound" }
  | { status: "unreadable" }
  | { status: "escape" }
  | { status: "changedIdentity"; resolvedRelativePath?: string }
  | { status: "notFile"; resolvedRelativePath: string }
  | { status: "tooLarge"; resolvedRelativePath: string }
  | {
      status: "inspected";
      resolvedRelativePath: string;
      sha256: string;
    };

export interface ProjectFileInspector {
  inspectProjectFile: (input: {
    projectRoot: string;
    relativePath: string;
    maximumBytes: number;
  }) => Promise<ProjectFileInspection>;
}
