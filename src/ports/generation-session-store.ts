import type {
  GenerationInFlight,
  GenerationSession,
  PendingConfirmation
} from "../domain/generation.js";

export const GENERATION_SESSION_STORE_ERROR_CODES = [
  "INVALID_ID",
  "INVALID_SESSION",
  "INVALID_REVISION",
  "SESSION_ALREADY_EXISTS",
  "SESSION_NOT_FOUND",
  "SESSION_PUBLISHED",
  "REVISION_CONFLICT",
  "INVALID_TRANSITION",
  "LOCK_TIMEOUT",
  "INVALID_EVIDENCE_PATH",
  "INVALID_EVIDENCE",
  "EVIDENCE_NOT_FOUND",
  "EVIDENCE_ALREADY_EXISTS",
  "SESSION_NOT_PUBLISHABLE",
  "PUBLISH_DESTINATION_EXISTS",
  "IO_ERROR"
] as const;

export type GenerationSessionStoreErrorCode =
  typeof GENERATION_SESSION_STORE_ERROR_CODES[number];

export class GenerationSessionStoreError extends Error {
  public constructor(
    public readonly code: GenerationSessionStoreErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "GenerationSessionStoreError";
  }
}

export interface GenerationEvidenceFile {
  path: string;
  contentBase64: string;
  byteLength: number;
}

export interface GenerationSessionStore {
  create: (session: GenerationSession) => Promise<void>;
  read: (id: string) => Promise<GenerationSession>;
  update: (
    id: string,
    expectedRevision: number,
    next: GenerationSession
  ) => Promise<void>;
  commitSnapshot: (
    id: string,
    expectedRevision: number,
    next: GenerationSession
  ) => Promise<void>;
  updateConfirmation: (
    id: string,
    expectedRevision: number,
    next: GenerationSession
  ) => Promise<void>;
  beginStep: (
    id: string,
    expectedRevision: number,
    inFlight: GenerationInFlight,
    approvedConfirmation?: PendingConfirmation
  ) => Promise<GenerationSession>;
  completeStep: (
    id: string,
    expectedRevision: number,
    expectedInFlight: GenerationInFlight,
    next: GenerationSession
  ) => Promise<void>;
  recover: (
    id: string,
    expectedRevision: number,
    next: GenerationSession
  ) => Promise<void>;
  beginVerification: (
    id: string,
    expectedRevision: number,
    attemptId: string,
    owner?: { pid: number; startedAt: string }
  ) => Promise<GenerationSession>;
  completeVerification: (
    id: string,
    expectedRevision: number,
    next: GenerationSession
  ) => Promise<void>;
  failVerification: (
    id: string,
    expectedRevision: number,
    next: GenerationSession
  ) => Promise<void>;
  recoverVerification: (
    id: string,
    expectedRevision: number,
    next: GenerationSession
  ) => Promise<void>;
  archive: (
    id: string,
    expectedRevision: number,
    next: GenerationSession
  ) => Promise<void>;
  list: () => Promise<readonly GenerationSession[]>;
  markBundlePublishable: (
    id: string,
    expectedRevision: number,
    next: GenerationSession
  ) => Promise<void>;
  writeEvidence: (
    id: string,
    relativePath: string,
    value: unknown
  ) => Promise<void>;
  writeTextEvidence: (
    id: string,
    relativePath: string,
    value: string
  ) => Promise<void>;
  produceEvidence: (
    id: string,
    relativePath: string,
    produce: (temporaryPath: string) => Promise<void>
  ) => Promise<void>;
  readEvidence: (id: string, relativePath: string) => Promise<Buffer>;
  evidenceReference: (
    id: string,
    relativePath: string
  ) => Promise<string>;
  listEvidence: (id: string) => Promise<readonly GenerationEvidenceFile[]>;
  publish: (id: string) => Promise<string>;
}
