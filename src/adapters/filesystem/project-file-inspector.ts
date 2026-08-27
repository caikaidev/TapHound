import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  open,
  realpath,
  stat,
  type FileHandle
} from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  type ProjectFileInspection,
  type ProjectFileInspector
} from "../../ports/project-file-inspector.js";
import { errnoCode } from "../../shared/errors.js";
import { isContained } from "../../shared/paths.js";

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
  );
}

async function fileIdentity(handle: FileHandle): Promise<FileIdentity> {
  const fileStats = await handle.stat({ bigint: true });
  return {
    dev: fileStats.dev,
    ino: fileStats.ino,
    size: fileStats.size,
    mtimeNs: fileStats.mtimeNs,
    ctimeNs: fileStats.ctimeNs
  };
}

async function pathIdentity(path: string): Promise<FileIdentity> {
  const fileStats = await stat(path, { bigint: true });
  return {
    dev: fileStats.dev,
    ino: fileStats.ino,
    size: fileStats.size,
    mtimeNs: fileStats.mtimeNs,
    ctimeNs: fileStats.ctimeNs
  };
}

function normalizedRelativePath(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

function evidenceFailure(error: unknown): ProjectFileInspection {
  return errnoCode(error) === "ENOENT" || errnoCode(error) === "ENOTDIR"
    ? { status: "notFound" }
    : { status: "unreadable" };
}

interface CachedRoot {
  readonly canonical: string;
  readonly identity: FileIdentity;
}

type RootResolution =
  | { readonly status: "resolved"; readonly canonical: string; readonly identity: FileIdentity }
  | { readonly status: "rootNotFound" }
  | { readonly status: "rootUnreadable" }
  | { readonly status: "rootNotDirectory" };

export class NodeProjectFileInspector implements ProjectFileInspector {
  private rootCache: Map<string, CachedRoot> | undefined;

  private readonly resolveRoot = async (
    projectRoot: string
  ): Promise<RootResolution> => {
    const cached = this.rootCache?.get(projectRoot);
    if (cached !== undefined) {
      try {
        const stats = await stat(cached.canonical, { bigint: true });
        if (stats.isDirectory()) {
          const identity: FileIdentity = {
            dev: stats.dev,
            ino: stats.ino,
            size: stats.size,
            mtimeNs: stats.mtimeNs,
            ctimeNs: stats.ctimeNs
          };
          if (sameIdentity(cached.identity, identity)) {
            return {
              status: "resolved",
              canonical: cached.canonical,
              identity: cached.identity
            };
          }
        }
      } catch {
        // cache stale, re-resolve below
      }
    }

    let canonical: string;
    try {
      canonical = await realpath(projectRoot);
    } catch (error: unknown) {
      return errnoCode(error) === "ENOENT" || errnoCode(error) === "ENOTDIR"
        ? { status: "rootNotFound" }
        : { status: "rootUnreadable" };
    }

    try {
      const rootStats = await stat(canonical, { bigint: true });
      if (!rootStats.isDirectory()) {
        return { status: "rootNotDirectory" };
      }
      const identity: FileIdentity = {
        dev: rootStats.dev,
        ino: rootStats.ino,
        size: rootStats.size,
        mtimeNs: rootStats.mtimeNs,
        ctimeNs: rootStats.ctimeNs
      };
      if (this.rootCache === undefined) {
        this.rootCache = new Map();
      }
      this.rootCache.set(projectRoot, { canonical, identity });
      return { status: "resolved", canonical, identity };
    } catch (error: unknown) {
      return errnoCode(error) === "ENOENT"
        ? { status: "rootNotFound" }
        : { status: "rootUnreadable" };
    }
  };

  public readonly inspectProjectFile = async (input: {
    projectRoot: string;
    relativePath: string;
    maximumBytes: number;
  }): Promise<ProjectFileInspection> => {
    const root = await this.resolveRoot(input.projectRoot);
    if (root.status !== "resolved") {
      return root;
    }
    const canonicalRoot = root.canonical;
    const rootBefore = root.identity;

    const normalizedPath = input.relativePath.replaceAll("\\", "/");
    if (
      normalizedPath.startsWith("/")
      || /^[A-Za-z]:/.test(normalizedPath)
      || normalizedPath.split("/").includes("..")
    ) {
      return { status: "escape" };
    }
    const candidate = resolve(canonicalRoot, normalizedPath);
    if (!isContained(canonicalRoot, candidate)) {
      return { status: "escape" };
    }

    let canonicalBefore: string;
    let pathBefore: FileIdentity;
    try {
      canonicalBefore = await realpath(candidate);
      if (!isContained(canonicalRoot, canonicalBefore)) {
        return { status: "escape" };
      }
      pathBefore = await pathIdentity(canonicalBefore);
    } catch (error: unknown) {
      return evidenceFailure(error);
    }

    const resolvedRelativePath = normalizedRelativePath(
      canonicalRoot,
      canonicalBefore
    );
    const openFlags = process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW;
    let handle: FileHandle;
    try {
      handle = await open(canonicalBefore, openFlags);
    } catch (error: unknown) {
      return errnoCode(error) === "ELOOP"
        ? { status: "changedIdentity", resolvedRelativePath }
        : evidenceFailure(error);
    }

    try {
      const openedBefore = await fileIdentity(handle);
      if (!sameIdentity(pathBefore, openedBefore)) {
        return { status: "changedIdentity", resolvedRelativePath };
      }
      const openedStats = await handle.stat({ bigint: true });
      if (!openedStats.isFile()) {
        return { status: "notFile", resolvedRelativePath };
      }
      try {
        const canonicalOpened = await realpath(candidate);
        const rootOpened = await realpath(input.projectRoot);
        const pathOpened = await pathIdentity(canonicalOpened);
        if (
          canonicalOpened !== canonicalBefore
          || rootOpened !== canonicalRoot
          || !isContained(canonicalRoot, canonicalOpened)
          || !sameIdentity(openedBefore, pathOpened)
        ) {
          return { status: "changedIdentity", resolvedRelativePath };
        }
      } catch {
        return { status: "changedIdentity", resolvedRelativePath };
      }

      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let tooLarge = false;
      while (totalBytes <= input.maximumBytes) {
        const remaining = input.maximumBytes + 1 - totalBytes;
        const bytesToRead = Math.min(buffer.byteLength, remaining);
        const readResult = await handle.read(buffer, 0, bytesToRead, null);
        if (readResult.bytesRead === 0) {
          break;
        }
        totalBytes += readResult.bytesRead;
        const chunk = Buffer.from(buffer.subarray(0, readResult.bytesRead));
        hash.update(chunk);
        chunks.push(chunk);
        if (totalBytes > input.maximumBytes) {
          tooLarge = true;
          break;
        }
      }

      const openedAfter = await fileIdentity(handle);
      let canonicalAfter: string;
      let rootCanonicalAfter: string;
      let pathAfter: FileIdentity;
      let rootAfter: FileIdentity;
      try {
        canonicalAfter = await realpath(candidate);
        rootCanonicalAfter = await realpath(input.projectRoot);
        pathAfter = await pathIdentity(canonicalAfter);
        rootAfter = await pathIdentity(canonicalRoot);
      } catch {
        return { status: "changedIdentity", resolvedRelativePath };
      }
      if (
        canonicalAfter !== canonicalBefore
        || rootCanonicalAfter !== canonicalRoot
        || !isContained(canonicalRoot, canonicalAfter)
        || !sameIdentity(openedBefore, openedAfter)
        || !sameIdentity(openedAfter, pathAfter)
        || !sameIdentity(rootBefore, rootAfter)
      ) {
        return { status: "changedIdentity", resolvedRelativePath };
      }

      return tooLarge
        ? { status: "tooLarge", resolvedRelativePath }
        : {
            status: "inspected",
            resolvedRelativePath,
            sha256: hash.digest("hex"),
            bytes: Buffer.concat(chunks)
          };
    } catch {
      return { status: "unreadable" };
    } finally {
      await handle.close().catch(() => undefined);
    }
  };
}
