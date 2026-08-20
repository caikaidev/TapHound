export type ContextDocumentWrite =
  | { status: "written"; sha256: string }
  | { status: "escape" }
  | { status: "unwritable"; message: string };

export interface ContextDocumentWriter {
  writeContextDocument: (input: {
    projectRoot: string;
    relativePath: string;
    document: unknown;
  }) => Promise<ContextDocumentWrite>;
}
