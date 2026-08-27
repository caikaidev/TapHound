export type ContextDocumentWrite =
  | { status: "written"; sha256: string }
  | { status: "escape" }
  | { status: "unwritable"; message: string };

export interface ContextDocumentBatchEntry {
  readonly relativePath: string;
  readonly document: unknown;
}

export interface ContextDocumentWriter {
  writeContextDocument: (input: {
    projectRoot: string;
    relativePath: string;
    document: unknown;
  }) => Promise<ContextDocumentWrite>;
  writeContextDocumentBatch?: (input: {
    projectRoot: string;
    documents: readonly ContextDocumentBatchEntry[];
  }) => Promise<readonly ContextDocumentWrite[]>;
}
