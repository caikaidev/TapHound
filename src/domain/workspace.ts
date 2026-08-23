import {
  isAbsolute,
  relative,
  resolve
} from "node:path";
import { posix } from "node:path";

export const TAPHOUND_DIR = ".taphound";
export const CONTEXT_DIR = `${TAPHOUND_DIR}/context`;
export const CONTEXT_INDEX_PATH = `${CONTEXT_DIR}/project-context.json`;
export const FLOWS_DIR = `${TAPHOUND_DIR}/flows`;
export const EXTERNAL_FLOWS_DIR = `${FLOWS_DIR}/external`;
export const JOURNEY_SOURCES_DIR = `${TAPHOUND_DIR}/sources`;
export const JOURNEYS_DIR = `${TAPHOUND_DIR}/journeys`;
export const BUILD_DIR = `${TAPHOUND_DIR}/build`;
export const GENERATIONS_DIR = `${BUILD_DIR}/generations`;
export const JOBS_DIR = `${BUILD_DIR}/jobs`;
export const DEFAULT_ARTIFACTS_DIR = `${BUILD_DIR}/runs`;
export const BUILD_IGNORE_FILE = `${TAPHOUND_DIR}/.gitignore`;
export const BUILD_IGNORE_CONTENT = "build/\n";

function isSameOrDescendant(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return fromParent.length === 0
    || (!fromParent.startsWith("..") && !isAbsolute(fromParent));
}

export function assertArtifactDirectory(
  projectRoot: string,
  artifactsDir: string
): void {
  const workspace = resolve(projectRoot, TAPHOUND_DIR);
  const build = resolve(projectRoot, BUILD_DIR);
  const candidate = resolve(projectRoot, artifactsDir);
  if (
    isSameOrDescendant(workspace, candidate)
    && !isSameOrDescendant(build, candidate)
  ) {
    throw new Error(
      `Artifact path inside ${TAPHOUND_DIR}/ must stay under ${BUILD_DIR}/: ${artifactsDir}`
    );
  }
}

export function isInvalidRelativeArtifactDirectory(path: string): boolean {
  const normalized = posix.normalize(path.replaceAll("\\", "/"));
  return (
    normalized === TAPHOUND_DIR
    || normalized.startsWith(`${TAPHOUND_DIR}/`)
  ) && !(
    normalized === BUILD_DIR
    || normalized.startsWith(`${BUILD_DIR}/`)
  );
}

export const LEGACY_WORKSPACE_DIRECTORIES = [
  `${TAPHOUND_DIR}/generations`,
  `${TAPHOUND_DIR}/jobs`,
  `${TAPHOUND_DIR}/runs`
] as const;

const LEGACY_MOVE_TARGETS: Record<string, string> = {
  [`${TAPHOUND_DIR}/generations`]: GENERATIONS_DIR,
  [`${TAPHOUND_DIR}/jobs`]: JOBS_DIR,
  [`${TAPHOUND_DIR}/runs`]: DEFAULT_ARTIFACTS_DIR
};

function legacyMoveTarget(path: string): string | undefined {
  return LEGACY_MOVE_TARGETS[path]
    ?? (path.startsWith(`${TAPHOUND_DIR}/`)
      ? `${DEFAULT_ARTIFACTS_DIR}/${path.slice(TAPHOUND_DIR.length + 1)}`
      : undefined);
}

export function legacyWorkspaceMessage(
  found: readonly string[]
): string {
  const moves = found.map((path) => {
    const target = legacyMoveTarget(path);
    return target === undefined
      ? `  rm -r ${path}`
      : `  mv ${path} ${target}`;
  });
  return [
    `Legacy TapHound workspace directories found: ${found.join(", ")}.`,
    `Every ephemeral artifact now lives under ${BUILD_DIR}/. Move them:`,
    ...moves,
    `Then set artifactsDir to ${DEFAULT_ARTIFACTS_DIR} or omit it to use the`,
    "default, and ignore only .taphound/build/ in version control."
  ].join("\n");
}
