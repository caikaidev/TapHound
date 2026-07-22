export type ProjectFileInspection =
  | { status: "notFile" }
  | { status: "tooLarge"; size: number }
  | { status: "inspected"; size: number; sha256: string };

export type ProjectFileInspectionFailure = "notFound" | "unreadable";

export class ProjectFileInspectionError extends Error {
  public constructor(
    public readonly failure: ProjectFileInspectionFailure,
    message: string
  ) {
    super(message);
    this.name = "ProjectFileInspectionError";
  }
}

export interface ProjectFileInspector {
  realPath: (path: string) => Promise<string>;
  inspectFile: (
    realPath: string,
    maximumBytes: number
  ) => Promise<ProjectFileInspection>;
}
