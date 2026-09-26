// Filesystem primitives of the session store: identity, evidence paths, and atomic state.

import { randomUUID } from "node:crypto";
import type { BigIntStats, Dirent } from "node:fs";
import {
  constants,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  posix,
  relative
} from "node:path";

import type {
  GenerationInFlight,
  GenerationSession
} from "../../../domain/generation.js";
import {
  GenerationSessionStoreError
} from "../../../ports/generation-session-store.js";
import { isErrnoException } from "../../../shared/errors.js";
import { compareStrings } from "../../../shared/strings.js";
import {
  parseSession,
  sessionId
} from "./session-transitions.js";


export interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

export interface FileSnapshotMetadata extends FileIdentity {
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export function snapshotMetadata(stats: BigIntStats): FileSnapshotMetadata {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs
  };
}

export function sameSnapshotMetadata(
  left: FileSnapshotMetadata,
  right: FileSnapshotMetadata
): boolean {
  return (
    sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
  );
}

export function evidenceEntryType(entry: Dirent): string {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

export function evidenceEntrySnapshot(
  entries: readonly Dirent[]
): readonly string[] {
  return entries
    .map((entry) => `${entry.name}\0${evidenceEntryType(entry)}`)
    .sort();
}

export interface DirectoryEvidence {
  path: string;
  canonicalPath: string;
  identity: FileIdentity;
}

export interface StoreDirectoryEvidence {
  path: string;
  canonicalPath: string;
  identity: FileIdentity;
}

export function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function captureStoreDirectory(
  path: string
): Promise<StoreDirectoryEvidence> {
  const stats = await lstat(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new GenerationSessionStoreError(
      "IO_ERROR",
      `Generation store path is not a real directory: ${path}`
    );
  }
  return {
    path,
    canonicalPath: await realpath(path),
    identity: { dev: stats.dev, ino: stats.ino }
  };
}

export async function verifyStoreDirectory(
  expected: StoreDirectoryEvidence
): Promise<void> {
  const current = await captureStoreDirectory(expected.path);
  if (
    current.canonicalPath !== expected.canonicalPath
    || !sameIdentity(current.identity, expected.identity)
  ) {
    throw new GenerationSessionStoreError(
      "IO_ERROR",
      `Generation store directory identity changed: ${expected.path}`
    );
  }
}

export async function captureStoreFile(path: string): Promise<FileIdentity> {
  const stats = await lstat(path, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new GenerationSessionStoreError(
      "IO_ERROR",
      `Generation store path is not a real file: ${path}`
    );
  }
  return { dev: stats.dev, ino: stats.ino };
}

export async function captureOptionalStoreFile(
  path: string
): Promise<FileIdentity | null> {
  try {
    return await captureStoreFile(path);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function verifyOptionalStoreFile(
  path: string,
  expected: FileIdentity | null
): Promise<void> {
  const current = await captureOptionalStoreFile(path);
  if (
    (current === null) !== (expected === null)
    || (
      current !== null
      && expected !== null
      && !sameIdentity(current, expected)
    )
  ) {
    throw new GenerationSessionStoreError(
      "IO_ERROR",
      `Generation state file identity changed: ${path}`
    );
  }
}

export function asStoreIoError(error: unknown, action: string): Error {
  if (error instanceof GenerationSessionStoreError) {
    return error;
  }
  return new GenerationSessionStoreError(
    "IO_ERROR",
    `Generation session store failed to ${action}`,
    { cause: error }
  );
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function requireRealDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new GenerationSessionStoreError(
      "IO_ERROR",
      `Generation store path is not a real directory: ${path}`
    );
  }
}

export async function createOrRequireDirectory(path: string): Promise<boolean> {
  let created = false;
  try {
    await mkdir(path);
    created = true;
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "EEXIST") {
      throw error;
    }
  }
  await requireRealDirectory(path);
  return created;
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function canonicalizeEvidenceValue(
  value: unknown,
  ancestors: Set<object> = new Set()
): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return value;
    }
    throw new GenerationSessionStoreError(
      "INVALID_EVIDENCE",
      "Evidence JSON cannot contain non-finite numbers"
    );
  }
  if (typeof value !== "object") {
    throw new GenerationSessionStoreError(
      "INVALID_EVIDENCE",
      "Evidence value must be JSON serializable"
    );
  }
  if (ancestors.has(value)) {
    throw new GenerationSessionStoreError(
      "INVALID_EVIDENCE",
      "Evidence JSON cannot contain cycles"
    );
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalizeEvidenceValue(item, ancestors));
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new GenerationSessionStoreError(
        "INVALID_EVIDENCE",
        "Evidence value must contain only JSON objects"
      );
    }

    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => compareStrings(left, right))
        .map((key) => [
          key,
          canonicalizeEvidenceValue(
            (value as Record<string, unknown>)[key],
            ancestors
          )
        ])
    );
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeEvidence(value: unknown): unknown {
  try {
    return canonicalizeEvidenceValue(value);
  } catch (error) {
    if (error instanceof GenerationSessionStoreError) {
      throw error;
    }
    throw new GenerationSessionStoreError(
      "INVALID_EVIDENCE",
      "Evidence value cannot be safely inspected",
      { cause: error }
    );
  }
}

export function validateEvidencePath(relativePath: unknown): string[] {
  if (
    typeof relativePath !== "string"
    || relativePath.length === 0
    || relativePath.includes("\\")
    || relativePath.includes("\0")
    || isAbsolute(relativePath)
    || posix.isAbsolute(relativePath)
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_EVIDENCE_PATH",
      "Invalid generation evidence path"
    );
  }

  const segments = relativePath.split("/");
  if (
    segments.some((segment) => (
      segment.length === 0
      || segment === "."
      || segment === ".."
    ))
    || posix.normalize(relativePath) !== relativePath
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_EVIDENCE_PATH",
      "Invalid generation evidence path"
    );
  }
  return segments;
}

export function assertContained(
  root: string,
  candidate: string,
  allowRoot = false
): void {
  const fromRoot = relative(root, candidate);
  if (
    (!allowRoot && fromRoot.length === 0)
    || fromRoot.startsWith("..")
    || isAbsolute(fromRoot)
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_EVIDENCE_PATH",
      `Evidence path escapes generation session: ${candidate}`
    );
  }
}

export async function captureDirectoryEvidence(
  path: string
): Promise<DirectoryEvidence> {
  const stats = await lstat(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new GenerationSessionStoreError(
      "INVALID_EVIDENCE_PATH",
      `Evidence parent is not a real directory: ${path}`
    );
  }
  return {
    path,
    canonicalPath: await realpath(path),
    identity: { dev: stats.dev, ino: stats.ino }
  };
}

export async function verifyDirectoryEvidence(
  activeCanonicalPath: string,
  directories: readonly DirectoryEvidence[]
): Promise<void> {
  for (const evidence of directories) {
    const current = await captureDirectoryEvidence(evidence.path);
    assertContained(activeCanonicalPath, current.canonicalPath, true);
    if (
      current.canonicalPath !== evidence.canonicalPath
      || current.identity.dev !== evidence.identity.dev
      || current.identity.ino !== evidence.identity.ino
    ) {
      throw new GenerationSessionStoreError(
        "INVALID_EVIDENCE_PATH",
        `Evidence parent identity changed: ${evidence.path}`
      );
    }
  }
}

export async function assertEvidenceNamespaceAvailable(
  activeDirectory: string,
  activeEvidence: StoreDirectoryEvidence,
  inFlight: GenerationInFlight
): Promise<void> {
  const relativePath = `evidence/steps/${String(inFlight.stepIndex)}-${
    inFlight.attemptId
  }`;
  const segments = validateEvidencePath(relativePath);
  await verifyStoreDirectory(activeEvidence);
  let parent = activeDirectory;
  const directories: DirectoryEvidence[] = [activeEvidence];

  for (const [index, segment] of segments.entries()) {
    const candidate = join(parent, segment);
    assertContained(activeDirectory, candidate);
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(candidate);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        await verifyDirectoryEvidence(
          activeEvidence.canonicalPath,
          directories
        );
        return;
      }
      throw error;
    }
    if (index === segments.length - 1) {
      throw new GenerationSessionStoreError(
        "EVIDENCE_ALREADY_EXISTS",
        `Generation attempt evidence namespace already exists: ${relativePath}`
      );
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new GenerationSessionStoreError(
        "INVALID_EVIDENCE_PATH",
        `Attempt evidence parent is not a safe directory: ${relativePath}`
      );
    }
    const evidence = await captureDirectoryEvidence(candidate);
    assertContained(activeEvidence.canonicalPath, evidence.canonicalPath, true);
    directories.push(evidence);
    parent = candidate;
  }
}

export async function fileIdentity(path: string): Promise<FileIdentity> {
  const stats = await lstat(path, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new GenerationSessionStoreError(
      "INVALID_EVIDENCE_PATH",
      `Evidence output is not a regular file: ${path}`
    );
  }
  return { dev: stats.dev, ino: stats.ino };
}

export function evidenceNotFound(
  relativePath: string,
  cause: unknown
): GenerationSessionStoreError {
  return new GenerationSessionStoreError(
    "EVIDENCE_NOT_FOUND",
    `Generation evidence does not exist: ${relativePath}`,
    { cause }
  );
}

export async function readStateFromDirectory(
  directory: string,
  afterOpen?: () => Promise<void> | void,
  expectedDirectory?: StoreDirectoryEvidence
): Promise<GenerationSession> {
  const directoryEvidence = expectedDirectory
    ?? await captureStoreDirectory(directory);
  await verifyStoreDirectory(directoryEvidence);
  const statePath = join(directory, "state.json");
  let text: string;
  try {
    const handle = await open(
      statePath,
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const openedStats = await handle.stat({ bigint: true });
      if (!openedStats.isFile()) {
        throw new GenerationSessionStoreError(
          "IO_ERROR",
          `Generation state is not a regular file: ${statePath}`
        );
      }
      const openedIdentity = {
        dev: openedStats.dev,
        ino: openedStats.ino
      };
      await afterOpen?.();
      await verifyStoreDirectory(directoryEvidence);
      const pathIdentity = await captureStoreFile(statePath);
      if (!sameIdentity(openedIdentity, pathIdentity)) {
        throw new GenerationSessionStoreError(
          "IO_ERROR",
          `Generation state file identity changed: ${statePath}`
        );
      }
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof GenerationSessionStoreError) {
      throw error;
    }
    throw new GenerationSessionStoreError(
      "IO_ERROR",
      `Unable to read generation session state: ${statePath}`,
      { cause: error }
    );
  }

  try {
    return parseSession(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof GenerationSessionStoreError) {
      throw error;
    }
    throw new GenerationSessionStoreError(
      "INVALID_SESSION",
      `Unable to parse generation session state: ${statePath}`,
      { cause: error }
    );
  }
}

export async function readBoundState(
  directory: string,
  id: string,
  afterOpen?: () => Promise<void> | void,
  expectedDirectory?: StoreDirectoryEvidence
): Promise<GenerationSession> {
  const session = await readStateFromDirectory(
    directory,
    afterOpen,
    expectedDirectory
  );
  if (sessionId(session) !== id) {
    throw new GenerationSessionStoreError(
      "INVALID_SESSION",
      "Persisted generation session id does not match its directory"
    );
  }
  return session;
}

export async function writeStateAtomically(
  directory: string,
  session: GenerationSession,
  sync: (path: string) => Promise<void> = syncDirectory,
  beforeRename?: () => Promise<void> | void,
  expectedDirectory?: StoreDirectoryEvidence,
  beforeInstall?: () => Promise<void> | void
): Promise<void> {
  const directoryEvidence = expectedDirectory
    ?? await captureStoreDirectory(directory);
  await verifyStoreDirectory(directoryEvidence);
  const statePath = join(directory, "state.json");
  const originalStateIdentity = await captureOptionalStoreFile(statePath);
  const temporaryPath = join(
    directory,
    `.state.json.${randomUUID()}.tmp`
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(serializeJson(session), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const temporaryIdentity = await captureStoreFile(temporaryPath);
    await beforeRename?.();
    await verifyStoreDirectory(directoryEvidence);
    await verifyOptionalStoreFile(statePath, originalStateIdentity);
    await beforeInstall?.();
    await rename(temporaryPath, statePath);
    const installedIdentity = await captureStoreFile(statePath);
    if (!sameIdentity(temporaryIdentity, installedIdentity)) {
      throw new GenerationSessionStoreError(
        "IO_ERROR",
        `Generation state install identity changed: ${statePath}`
      );
    }
    await sync(directory);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
