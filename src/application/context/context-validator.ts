import {
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";

import { normalizeActivity } from "../../domain/activity.js";
import type { TapHoundConfig } from "../../domain/config.js";
import { ProjectContextSchema } from "../../domain/project-context.js";
import {
  ProjectFileInspectionError,
  type ProjectFileInspector
} from "../../ports/project-file-inspector.js";

export const MAX_CONTEXT_EVIDENCE_BYTES = 1024 * 1024;

export type ContextValidationReasonCode =
  | "CONTEXT_SCHEMA_INVALID"
  | "CONTEXT_IDENTITY_MISMATCH"
  | "PROJECT_ROOT_UNREADABLE"
  | "EVIDENCE_SECRET_PATH"
  | "EVIDENCE_NOT_FOUND"
  | "EVIDENCE_UNREADABLE"
  | "EVIDENCE_NOT_FILE"
  | "EVIDENCE_PATH_ESCAPE"
  | "EVIDENCE_TOO_LARGE"
  | "EVIDENCE_HASH_MISMATCH";

export interface ContextValidationReason {
  code: ContextValidationReasonCode;
  message: string;
}

export type ContextValidationResult =
  | { status: "valid" }
  | { status: "stale"; reason: ContextValidationReason }
  | { status: "invalid"; reason: ContextValidationReason };

export interface ContextValidationInput {
  context: unknown;
  projectRoot: string;
  config: TapHoundConfig;
}

const SECRET_FILE_NAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "secret.json",
  "secrets.json"
]);

const SECRET_FILE_EXTENSIONS = [
  ".jks",
  ".key",
  ".keystore",
  ".p12",
  ".pem",
  ".pfx"
];

function isSecretEvidencePath(path: string): boolean {
  const fileName = path.split("/").at(-1)?.toLowerCase() ?? "";
  return (
    /^\.env(?:\.|$)/.test(fileName)
    || SECRET_FILE_NAMES.has(fileName)
    || SECRET_FILE_EXTENSIONS.some((extension) => fileName.endsWith(extension))
  );
}

function isContained(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot === ""
    || (
      fromRoot !== ".."
      && !fromRoot.startsWith(`..${sep}`)
      && !isAbsolute(fromRoot)
    )
  );
}

function invalid(
  code: ContextValidationReasonCode,
  message: string
): ContextValidationResult {
  return { status: "invalid", reason: { code, message } };
}

function inspectionFailure(
  path: string,
  error: unknown
): ContextValidationResult {
  if (
    error instanceof ProjectFileInspectionError
    && error.failure === "notFound"
  ) {
    return invalid(
      "EVIDENCE_NOT_FOUND",
      `Evidence file does not exist: ${path}`
    );
  }
  return invalid(
    "EVIDENCE_UNREADABLE",
    `Evidence file cannot be read: ${path}`
  );
}

export class ContextValidator {
  public constructor(private readonly files: ProjectFileInspector) {}

  public readonly validate = async (
    input: ContextValidationInput
  ): Promise<ContextValidationResult> => {
    const parsed = ProjectContextSchema.safeParse(input.context);
    if (!parsed.success) {
      return invalid(
        "CONTEXT_SCHEMA_INVALID",
        "Project Context does not match the version 1 schema"
      );
    }

    let configuredActivity: string;
    try {
      configuredActivity = normalizeActivity(
        input.config.run.packageName,
        input.config.run.activity
      );
    } catch {
      return invalid(
        "CONTEXT_IDENTITY_MISMATCH",
        "Project Context identity does not match the configured project"
      );
    }

    if (
      parsed.data.packageName !== input.config.run.packageName
      || parsed.data.launchActivity !== configuredActivity
    ) {
      return invalid(
        "CONTEXT_IDENTITY_MISMATCH",
        "Project Context identity does not match the configured project"
      );
    }

    let projectRoot: string;
    try {
      projectRoot = await this.files.realPath(input.projectRoot);
    } catch {
      return invalid(
        "PROJECT_ROOT_UNREADABLE",
        "Project root does not exist or cannot be read"
      );
    }

    let staleReason: ContextValidationReason | undefined;
    for (const evidence of parsed.data.manifest.files) {
      if (isSecretEvidencePath(evidence.path)) {
        return invalid(
          "EVIDENCE_SECRET_PATH",
          `Secret files cannot be context evidence: ${evidence.path}`
        );
      }

      const candidate = resolve(projectRoot, evidence.path);
      let evidenceRealPath: string;
      try {
        evidenceRealPath = await this.files.realPath(candidate);
      } catch (error: unknown) {
        return inspectionFailure(evidence.path, error);
      }

      if (!isContained(projectRoot, evidenceRealPath)) {
        return invalid(
          "EVIDENCE_PATH_ESCAPE",
          `Evidence file resolves outside the project: ${evidence.path}`
        );
      }
      const resolvedRelativePath = relative(projectRoot, evidenceRealPath)
        .replaceAll("\\", "/");
      if (isSecretEvidencePath(resolvedRelativePath)) {
        return invalid(
          "EVIDENCE_SECRET_PATH",
          `Secret files cannot be context evidence: ${evidence.path}`
        );
      }

      let inspection;
      try {
        inspection = await this.files.inspectFile(
          evidenceRealPath,
          MAX_CONTEXT_EVIDENCE_BYTES
        );
      } catch (error: unknown) {
        return inspectionFailure(evidence.path, error);
      }

      if (inspection.status === "notFile") {
        return invalid(
          "EVIDENCE_NOT_FILE",
          `Evidence path is not a file: ${evidence.path}`
        );
      }
      if (inspection.status === "tooLarge") {
        return invalid(
          "EVIDENCE_TOO_LARGE",
          `Evidence file exceeds ${String(MAX_CONTEXT_EVIDENCE_BYTES)} bytes: ${evidence.path}`
        );
      }
      if (inspection.sha256 !== evidence.sha256) {
        staleReason ??= {
          code: "EVIDENCE_HASH_MISMATCH",
          message: `Evidence file changed: ${evidence.path}`
        };
      }
    }

    return staleReason === undefined
      ? { status: "valid" }
      : { status: "stale", reason: staleReason };
  };
}
