import {
  isAbsolute,
  relative,
  resolve
} from "node:path";
import { posix } from "node:path";

export const TAPHOUND_DIR = ".taphound";
export const CONFIG_PATH = `${TAPHOUND_DIR}/config.json`;
export const CONTEXT_DIR = `${TAPHOUND_DIR}/context`;
export const CONTEXT_INDEX_PATH = `${CONTEXT_DIR}/project-context.json`;
export const KNOWLEDGE_DIR = `${TAPHOUND_DIR}/knowledge`;
export const KNOWLEDGE_INDEX_PATH = `${KNOWLEDGE_DIR}/index.json`;
export const KNOWLEDGE_ANCHORS_DIR = `${KNOWLEDGE_DIR}/anchors`;
export const KNOWLEDGE_SCREENS_DIR = `${KNOWLEDGE_DIR}/screens`;
export const FLOWS_DIR = `${TAPHOUND_DIR}/flows`;
export const EXTERNAL_FLOWS_DIR = `${FLOWS_DIR}/external`;
export const JOURNEY_SOURCES_DIR = `${TAPHOUND_DIR}/sources`;
export const JOURNEYS_DIR = `${TAPHOUND_DIR}/journeys`;
export const CONTRACTS_DIR = `${TAPHOUND_DIR}/contracts`;
export const BASELINES_DIR = `${TAPHOUND_DIR}/baselines`;
export const BUILD_DIR = `${TAPHOUND_DIR}/build`;
export const GENERATIONS_DIR = `${BUILD_DIR}/generations`;
export const JOBS_DIR = `${BUILD_DIR}/jobs`;
export const DEFAULT_ARTIFACTS_DIR = `${BUILD_DIR}/runs`;
export const WORKFLOWS_DIR = `${BUILD_DIR}/workflows`;

export function workflowManifestPath(caseId: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(caseId)) {
    throw new Error("Workflow Case id must be a safe lowercase path component");
  }
  return `${WORKFLOWS_DIR}/${caseId}/manifest.json`;
}

export const BUILD_IGNORE_FILE = `${TAPHOUND_DIR}/.gitignore`;
export const BUILD_IGNORE_CONTENT = "build/\n";
export const GENERATION_CONTEXT_SNAPSHOT_PATH = "context/resolved.json";

function isSameOrDescendant(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return fromParent.length === 0
    || (!fromParent.startsWith("..") && !isAbsolute(fromParent));
}

export function assertArtifactDirectory(
  projectRoot: string,
  artifactsDir: string,
  relativeAuthorityRoot = BUILD_DIR
): void {
  const build = resolve(projectRoot, relativeAuthorityRoot);
  const candidate = resolve(projectRoot, artifactsDir);
  if (!isSameOrDescendant(build, candidate)) {
    throw new Error(
      `Artifact output must stay under ${BUILD_DIR}/: ${artifactsDir}`
    );
  }
}

export function isInvalidRelativeArtifactDirectory(path: string): boolean {
  const normalized = posix.normalize(path.replaceAll("\\", "/"));
  return !posix.isAbsolute(normalized)
    && normalized !== BUILD_DIR
    && !normalized.startsWith(`${BUILD_DIR}/`);
}

export function assertProjectPathUnder(
  projectRoot: string,
  outputPath: string,
  relativeRoot: string,
  label: string
): string {
  const root = resolve(projectRoot, relativeRoot);
  const candidate = resolve(projectRoot, outputPath);
  if (!isSameOrDescendant(root, candidate)) {
    throw new Error(`${label} must stay under ${relativeRoot}/: ${outputPath}`);
  }
  return candidate;
}

const SNAPSHOT_EVIDENCE_REFERENCE_PATTERN = new RegExp(
  `^${
    GENERATIONS_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }/([^/]+)/(evidence/snapshots/revision-\\d+/[^/]+/snapshot\\.json)$`
);

export function activeGenerationBundleName(id: string): string {
  return `.${id}.work`;
}

export function parseSnapshotEvidenceReference(
  reference: string,
  generationId: string
): string | null {
  const match = SNAPSHOT_EVIDENCE_REFERENCE_PATTERN.exec(reference);
  if (match === null) {
    return null;
  }
  const bundleName = match[1] ?? "";
  if (
    bundleName !== generationId
    && bundleName !== activeGenerationBundleName(generationId)
  ) {
    return null;
  }
  return match[2] ?? null;
}
