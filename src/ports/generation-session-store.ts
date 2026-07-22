import type {
  GenerationInFlight,
  GenerationSession
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

export interface GenerationSessionStore {
  create: (session: GenerationSession) => Promise<void>;
  read: (id: string) => Promise<GenerationSession>;
  update: (
    id: string,
    expectedRevision: number,
    next: GenerationSession
  ) => Promise<void>;
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
  writeEvidence: (
    id: string,
    relativePath: string,
    value: unknown
  ) => Promise<void>;
  publish: (id: string) => Promise<string>;
}
