import { semanticSha256 } from "./evidence-hash.js";

export interface EvidenceRecord {
  readonly sha256: string;
  readonly semanticSha256?: string | undefined;
}

export interface InspectedFile {
  readonly sha256: string;
  readonly bytes?: Buffer | undefined;
}

export function evidenceMatches(
  evidence: EvidenceRecord,
  inspected: InspectedFile
): boolean {
  if (evidence.semanticSha256 !== undefined) {
    return inspected.bytes !== undefined
      && semanticSha256(inspected.bytes) === evidence.semanticSha256;
  }
  return inspected.sha256 === evidence.sha256;
}
