import { randomUUID } from "node:crypto";
import {
  constants,
  link,
  lstat,
  open,
  rename,
  unlink
} from "node:fs/promises";
import {
  join
} from "node:path";

import {
  GenerationSessionStoreError
} from "../../../ports/generation-session-store.js";
import { isErrnoException } from "../../../shared/errors.js";
import type {
  FileSystemGenerationSessionStoreHooks
} from "../generation-session-store.js";
import {
  type FileIdentity,
  type StoreDirectoryEvidence,
  asStoreIoError,
  captureStoreDirectory,
  serializeJson,
  verifyStoreDirectory
} from "./store-files.js";

export interface SessionLockConfig {
  generationRoot: string;
  locksRoot: string;
  lockTimeoutMs: number;
  lockRetryMs: number;
  hooks: Pick<
    FileSystemGenerationSessionStoreHooks,
    "beforeLockStagingWrite" | "beforeLockInstall" | "afterLockTombstoneRename"
  >;
}

export interface LockOwner {
  pid: number;
  token: string;
}

/**
 * The per-session exclusive lock: a linked owner file, reaped only when its
 * owner process is gone. Every store operation runs inside `withLock`.
 */
export class SessionLock {
  public constructor(private readonly config: SessionLockConfig) {}

  private readonly lockPath = (id: string): string => (
    join(this.config.locksRoot, `${id}.lock`)
  );

  public readonly withLock = async <T>(
    id: string,
    operation: () => Promise<T>
  ): Promise<T> => {
    const token = randomUUID();
    let generationRootEvidence: StoreDirectoryEvidence;
    let locksRootEvidence: StoreDirectoryEvidence;
    try {
      generationRootEvidence = await captureStoreDirectory(
        this.config.generationRoot
      );
      locksRootEvidence = await captureStoreDirectory(this.config.locksRoot);
      await this.acquireLock(
        id,
        { pid: process.pid, token },
        generationRootEvidence,
        locksRootEvidence
      );
      await verifyStoreDirectory(generationRootEvidence);
      await verifyStoreDirectory(locksRootEvidence);
    } catch (error) {
      throw asStoreIoError(error, "acquire its exclusive lock");
    }
    let outcome:
      | { status: "succeeded"; value: T }
      | { status: "failed"; error: unknown };
    let releaseError: unknown;
    try {
      outcome = {
        status: "succeeded",
        value: await operation()
      };
    } catch (error) {
      outcome = { status: "failed", error };
    } finally {
      try {
        await this.releaseLock(id, token);
      } catch (error) {
        releaseError = error;
      }
    }
    if (outcome.status === "failed") {
      throw asStoreIoError(outcome.error, "complete a locked operation");
    }
    if (releaseError !== undefined) {
      throw asStoreIoError(releaseError, "release its exclusive lock");
    }
    return outcome.value;
  };

  private readonly acquireLock = async (
    id: string,
    owner: LockOwner,
    generationRootEvidence: StoreDirectoryEvidence,
    locksRootEvidence: StoreDirectoryEvidence
  ): Promise<void> => {
    const lockPath = this.lockPath(id);
    const deadline = Date.now() + this.config.lockTimeoutMs;
    for (;;) {
      if (await this.tryInstallLock(
        id,
        lockPath,
        owner,
        generationRootEvidence,
        locksRootEvidence
      )) {
        return;
      }

      await this.reapDeadOwnerLock(id, lockPath);
      if (Date.now() >= deadline) {
        throw new GenerationSessionStoreError(
          "LOCK_TIMEOUT",
          `Timed out acquiring generation session lock: ${id}`
        );
      }
      await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, this.config.lockRetryMs);
      });
    }
  };

  private readonly tryInstallLock = async (
    id: string,
    lockPath: string,
    owner: LockOwner,
    generationRootEvidence: StoreDirectoryEvidence,
    locksRootEvidence: StoreDirectoryEvidence
  ): Promise<boolean> => {
    const stagingPath = join(
      this.config.locksRoot,
      `.${id}.lock.acquire-${randomUUID()}.tmp`
    );
    try {
      const handle = await open(stagingPath, "wx", 0o600);
      try {
        await this.config.hooks.beforeLockStagingWrite?.();
        await handle.writeFile(serializeJson(owner), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.config.hooks.beforeLockInstall?.();
      await verifyStoreDirectory(generationRootEvidence);
      await verifyStoreDirectory(locksRootEvidence);
      try {
        await link(stagingPath, lockPath);
      } catch (error) {
        if (isErrnoException(error) && error.code === "EEXIST") {
          return false;
        }
        throw error;
      }
      // The lock excludes other processes as soon as link() returns; it
      // needs no directory sync. Only its owner record is synced (above), so
      // a lock that survives a power loss names a dead owner and is reaped.
      try {
        await verifyStoreDirectory(generationRootEvidence);
        await verifyStoreDirectory(locksRootEvidence);
      } catch (error) {
        await this.releaseLock(id, owner.token).catch(() => undefined);
        throw error;
      }
      return true;
    } finally {
      await unlink(stagingPath).catch(() => undefined);
    }
  };

  private readonly reapDeadOwnerLock = async (
    id: string,
    lockPath: string
  ): Promise<void> => {
    try {
      const identity = await this.fileIdentity(lockPath);
      const owner = await this.readLockOwner(lockPath);
      if (owner === null || this.isProcessAlive(owner.pid)) {
        return;
      }

      const tombstone = join(
        this.config.locksRoot,
        `.${id}.lock.reap-${randomUUID()}`
      );
      await rename(lockPath, tombstone);
      const movedIdentity = await this.fileIdentity(tombstone);
      if (
        movedIdentity.dev !== identity.dev
        || movedIdentity.ino !== identity.ino
      ) {
        await rename(tombstone, lockPath).catch(() => undefined);
        return;
      }
      await this.config.hooks.afterLockTombstoneRename?.();
      await unlink(tombstone);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  };

  private readonly releaseLock = async (
    id: string,
    token: string
  ): Promise<void> => {
    const lockPath = this.lockPath(id);
    try {
      const identity = await this.fileIdentity(lockPath);
      const current = await this.readLockOwner(lockPath);
      if (current?.pid === process.pid && current.token === token) {
        const tombstone = join(
          this.config.locksRoot,
          `.${id}.lock.release-${randomUUID()}`
        );
        await rename(lockPath, tombstone);
        const movedIdentity = await this.fileIdentity(tombstone);
        if (
          movedIdentity.dev === identity.dev
          && movedIdentity.ino === identity.ino
        ) {
          // A release lost to a power loss reappears as a dead-owner lock,
          // which the next acquirer reaps; it needs no directory sync.
          await unlink(tombstone);
        } else {
          await rename(tombstone, lockPath).catch(() => undefined);
        }
      }
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  };

  private readonly readLockOwner = async (
    lockPath: string
  ): Promise<LockOwner | null> => {
    const handle = await open(
      lockPath,
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const value = JSON.parse(await handle.readFile("utf8")) as unknown;
      if (
        value === null
        || typeof value !== "object"
        || !Number.isSafeInteger((value as { pid?: unknown }).pid)
        || (value as { pid: number }).pid <= 0
        || typeof (value as { token?: unknown }).token !== "string"
        || (value as { token: string }).token.length === 0
      ) {
        return null;
      }
      return value as LockOwner;
    } catch {
      return null;
    } finally {
      await handle.close();
    }
  };

  private readonly fileIdentity = async (
    path: string
  ): Promise<FileIdentity> => {
    const stats = await lstat(path, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new GenerationSessionStoreError(
        "IO_ERROR",
        `Generation lock path is not a real file: ${path}`
      );
    }
    return { dev: stats.dev, ino: stats.ino };
  };

  private readonly isProcessAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return !isErrnoException(error) || error.code !== "ESRCH";
    }
  };
}
