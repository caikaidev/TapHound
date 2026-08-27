import { randomUUID } from "node:crypto";
import {
  constants,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink
} from "node:fs/promises";
import {
  basename,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";

import type {
  ProjectBoundPath
} from "../../ports/project-bound-file.js";
import { isErrnoException } from "../../shared/errors.js";

export interface ProjectBoundFileHooks {
  beforeInstall?: (() => Promise<void> | void) | undefined;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface DirectoryIdentity extends FileIdentity {
  path: string;
  canonicalPath: string;
}

interface BoundOutput {
  root: DirectoryIdentity;
  authority: DirectoryIdentity;
  parent: DirectoryIdentity;
  directories: readonly DirectoryIdentity[];
  outputPath: string;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function captureDirectory(path: string): Promise<DirectoryIdentity> {
  const stats = await lstat(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Project-bound path is not a safe directory: ${path}`);
  }
  return {
    path,
    canonicalPath: await realpath(path),
    dev: stats.dev,
    ino: stats.ino
  };
}

async function captureFile(path: string): Promise<FileIdentity> {
  const stats = await lstat(path, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Project-bound destination is not a regular file: ${path}`);
  }
  return { dev: stats.dev, ino: stats.ino };
}

async function captureOptionalFile(
  path: string
): Promise<FileIdentity | null> {
  try {
    return await captureFile(path);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function relativeInside(root: string, candidate: string): string {
  const fromRoot = relative(root, candidate);
  if (
    fromRoot.length === 0
    || fromRoot === ".."
    || fromRoot.startsWith(`..${sep}`)
    || isAbsolute(fromRoot)
  ) {
    throw new Error("Project-bound output escapes the real project root");
  }
  return fromRoot;
}

function assertOutsideAuthority(
  authorityCanonicalPath: string,
  candidateCanonicalPath: string
): void {
  const fromAuthority = relative(
    authorityCanonicalPath,
    candidateCanonicalPath
  );
  if (
    fromAuthority.length === 0
    || (
      fromAuthority !== ".."
      && !fromAuthority.startsWith(`..${sep}`)
      && !isAbsolute(fromAuthority)
    )
  ) {
    throw new Error("Project-bound output overlaps the authority subtree");
  }
}

async function verifyDirectory(expected: DirectoryIdentity): Promise<void> {
  const current = await captureDirectory(expected.path);
  if (
    current.canonicalPath !== expected.canonicalPath
    || !sameIdentity(current, expected)
  ) {
    throw new Error(`Project-bound directory identity changed: ${expected.path}`);
  }
}

async function verifyBoundOutput(bound: BoundOutput): Promise<void> {
  for (const directory of bound.directories) {
    await verifyDirectory(directory);
  }
  await verifyDirectory(bound.authority);
  relativeInside(bound.root.canonicalPath, bound.parent.canonicalPath);
  assertOutsideAuthority(
    bound.authority.canonicalPath,
    bound.parent.canonicalPath
  );
}

async function verifyOptionalFile(
  path: string,
  expected: FileIdentity | null
): Promise<void> {
  const current = await captureOptionalFile(path);
  if (
    (current === null) !== (expected === null)
    || (
      current !== null
      && expected !== null
      && !sameIdentity(current, expected)
    )
  ) {
    throw new Error(`Project-bound destination identity changed: ${path}`);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function lexicalSegments(root: string, output: string): string[] {
  const fromRoot = relative(root, output);
  if (
    fromRoot.length === 0
    || fromRoot === ".."
    || fromRoot.startsWith(`..${sep}`)
    || isAbsolute(fromRoot)
  ) {
    throw new Error("Project-bound output must stay within the project");
  }
  const segments = fromRoot.split(sep);
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    throw new Error("Project-bound output path must be normalized");
  }
  return segments;
}

async function prepareBoundOutput(
  input: ProjectBoundPath,
  createParents: boolean
): Promise<BoundOutput> {
  const projectPath = resolve(input.projectRoot);
  const outputPath = resolve(input.outputPath);
  const authorityPath = resolve(input.authorityRoot);
  const segments = lexicalSegments(projectPath, outputPath);
  const root = await captureDirectory(projectPath);
  const authority = await captureDirectory(authorityPath);
  relativeInside(root.canonicalPath, authority.canonicalPath);
  const authorityFromRoot = relative(root.canonicalPath, authority.canonicalPath);
  if (
    authorityFromRoot === ".."
    || authorityFromRoot.startsWith(`..${sep}`)
    || isAbsolute(authorityFromRoot)
  ) {
    throw new Error("Authority root escapes the real project root");
  }

  let current = projectPath;
  const directories: DirectoryIdentity[] = [root];
  for (const segment of segments.slice(0, -1)) {
    const next = resolve(current, segment);
    try {
      const captured = await captureDirectory(next);
      relativeInside(root.canonicalPath, captured.canonicalPath);
      assertOutsideAuthority(authority.canonicalPath, captured.canonicalPath);
      directories.push(captured);
    } catch (error) {
      if (
        !createParents
        || !isErrnoException(error)
        || error.code !== "ENOENT"
      ) {
        throw error;
      }
      await verifyDirectory(directories.at(-1) as DirectoryIdentity);
      await mkdir(next);
      await syncDirectory(current);
      const captured = await captureDirectory(next);
      relativeInside(root.canonicalPath, captured.canonicalPath);
      assertOutsideAuthority(authority.canonicalPath, captured.canonicalPath);
      directories.push(captured);
    }
    current = next;
  }
  const parent = directories.at(-1);
  if (parent === undefined) {
    throw new Error("Project-bound output parent is unavailable");
  }
  const bound = {
    root,
    authority,
    parent,
    directories,
    outputPath
  };
  await verifyBoundOutput(bound);
  return bound;
}

async function safeTemporaryCleanup(
  bound: BoundOutput,
  temporaryPath: string,
  expected: FileIdentity | undefined
): Promise<void> {
  if (expected === undefined) {
    return;
  }
  try {
    await verifyBoundOutput(bound);
    const current = await captureFile(temporaryPath);
    if (sameIdentity(current, expected)) {
      await unlink(temporaryPath);
      await syncDirectory(bound.parent.path);
    }
  } catch {
    // Never follow a substituted path to clean up.
  }
}

export async function writeProjectBoundText(
  input: ProjectBoundPath,
  value: string,
  hooks: ProjectBoundFileHooks = {}
): Promise<void> {
  const bound = await prepareBoundOutput(input, true);
  const originalDestination = await captureOptionalFile(bound.outputPath);
  const temporaryPath = resolve(
    bound.parent.path,
    `.${basename(bound.outputPath)}.${randomUUID()}.tmp`
  );
  let temporaryIdentity: FileIdentity | undefined;
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
    await handle.writeFile(value, "utf8");
    await handle.sync();
    const stats = await handle.stat({ bigint: true });
    temporaryIdentity = { dev: stats.dev, ino: stats.ino };
    await handle.close();
    handle = undefined;
    await hooks.beforeInstall?.();
    await verifyBoundOutput(bound);
    await verifyOptionalFile(bound.outputPath, originalDestination);
    const stagedIdentity = await captureFile(temporaryPath);
    if (!sameIdentity(stagedIdentity, temporaryIdentity)) {
      throw new Error("Project-bound temporary file identity changed");
    }
    await rename(temporaryPath, bound.outputPath);
    const installedIdentity = await captureFile(bound.outputPath);
    if (!sameIdentity(installedIdentity, temporaryIdentity)) {
      throw new Error("Project-bound installed file identity changed");
    }
    await syncDirectory(bound.parent.path);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await safeTemporaryCleanup(bound, temporaryPath, temporaryIdentity);
    throw error;
  }
}

export async function readProjectBoundFile(
  input: ProjectBoundPath
): Promise<Buffer> {
  const bound = await prepareBoundOutput(input, false);
  const handle = await open(
    bound.outputPath,
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile()) {
      throw new Error("Project-bound output is not a regular file");
    }
    const openedIdentity = { dev: stats.dev, ino: stats.ino };
    await verifyBoundOutput(bound);
    const pathIdentity = await captureFile(bound.outputPath);
    if (!sameIdentity(openedIdentity, pathIdentity)) {
      throw new Error("Project-bound output identity changed");
    }
    const bytes = await handle.readFile();
    await verifyBoundOutput(bound);
    const finalIdentity = await captureFile(bound.outputPath);
    if (!sameIdentity(openedIdentity, finalIdentity)) {
      throw new Error("Project-bound output identity changed during read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}
