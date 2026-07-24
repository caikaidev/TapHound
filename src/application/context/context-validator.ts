import { normalizeActivity } from "../../domain/activity.js";
import type { TapHoundConfig } from "../../domain/config.js";
import { ProjectContextSchema } from "../../domain/project-context.js";
import {
  type ProjectFileInspection,
  type ProjectFileInspector
} from "../../ports/project-file-inspector.js";

export const MAX_CONTEXT_EVIDENCE_BYTES = 1024 * 1024;

export type ContextValidationReasonCode =
  | "CONTEXT_SCHEMA_INVALID"
  | "CONTEXT_IDENTITY_MISMATCH"
  | "PROJECT_ROOT_UNREADABLE"
  | "PROJECT_ROOT_NOT_DIRECTORY"
  | "EVIDENCE_SECRET_PATH"
  | "EVIDENCE_NOT_FOUND"
  | "EVIDENCE_UNREADABLE"
  | "EVIDENCE_NOT_FILE"
  | "EVIDENCE_PATH_ESCAPE"
  | "EVIDENCE_CHANGED_IDENTITY"
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
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "keystore.properties",
  "local.properties",
  "secret.json",
  "secrets.json"
]);

const SECRET_FILE_EXTENSIONS = [
  ".der",
  ".jks",
  ".key",
  ".keystore",
  ".p12",
  ".pk8",
  ".pem",
  ".pfx",
  ".ppk"
];

function isSecretEvidencePath(path: string): boolean {
  const components = path
    .replaceAll("\\", "/")
    .split("/")
    .filter((component) => component.length > 0)
    .map((component) => component.toLowerCase());
  const fileName = components.at(-1) ?? "";
  return (
    components.some((component) => (
      component.startsWith(".env")
      || component === ".secrets"
      || component === ".credentials"
      || component === ".ssh"
      || component === ".gnupg"
    ))
    || SECRET_FILE_NAMES.has(fileName)
    || /^credentials(?:\.|$)/.test(fileName)
    || /^service-account(?:\.|$)/.test(fileName)
    || SECRET_FILE_EXTENSIONS.some((extension) => fileName.endsWith(extension))
  );
}

function invalid(
  code: ContextValidationReasonCode,
  message: string
): ContextValidationResult {
  return { status: "invalid", reason: { code, message } };
}

function invalidInspection(
  path: string,
  inspection: Exclude<ProjectFileInspection, { status: "inspected" }>
): ContextValidationResult {
  switch (inspection.status) {
    case "rootNotFound":
    case "rootUnreadable":
      return invalid(
        "PROJECT_ROOT_UNREADABLE",
        "Project root does not exist or cannot be read"
      );
    case "rootNotDirectory":
      return invalid(
        "PROJECT_ROOT_NOT_DIRECTORY",
        "Project root is not a directory"
      );
    case "notFound":
      return invalid(
        "EVIDENCE_NOT_FOUND",
        `Evidence file does not exist: ${path}`
      );
    case "unreadable":
      return invalid(
        "EVIDENCE_UNREADABLE",
        `Evidence file cannot be read: ${path}`
      );
    case "escape":
      return invalid(
        "EVIDENCE_PATH_ESCAPE",
        `Evidence file resolves outside the project: ${path}`
      );
    case "changedIdentity":
      return invalid(
        "EVIDENCE_CHANGED_IDENTITY",
        `Evidence file changed during inspection: ${path}`
      );
    case "notFile":
      return invalid(
        "EVIDENCE_NOT_FILE",
        `Evidence path is not a file: ${path}`
      );
    case "tooLarge":
      return invalid(
        "EVIDENCE_TOO_LARGE",
        `Evidence file exceeds ${String(MAX_CONTEXT_EVIDENCE_BYTES)} bytes: ${path}`
      );
  }
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

    let staleReason: ContextValidationReason | undefined;
    for (const evidence of parsed.data.manifest.files) {
      if (isSecretEvidencePath(evidence.path)) {
        return invalid(
          "EVIDENCE_SECRET_PATH",
          `Secret files cannot be context evidence: ${evidence.path}`
        );
      }

      const inspection = await this.files.inspectProjectFile({
        projectRoot: input.projectRoot,
        relativePath: evidence.path,
        maximumBytes: MAX_CONTEXT_EVIDENCE_BYTES
      });
      if (
        "resolvedRelativePath" in inspection
        && isSecretEvidencePath(inspection.resolvedRelativePath)
      ) {
        return invalid(
          "EVIDENCE_SECRET_PATH",
          `Secret files cannot be context evidence: ${evidence.path}`
        );
      }

      if (inspection.status !== "inspected") {
        return invalidInspection(evidence.path, inspection);
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
