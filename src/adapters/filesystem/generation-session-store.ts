import { randomUUID } from "node:crypto";
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
  relative,
  resolve
} from "node:path";

import {
  GenerationSessionSchema,
  type GenerationSession
} from "../../domain/generation.js";
import {
  GenerationSessionStoreError,
  type GenerationSessionStore
} from "../../ports/generation-session-store.js";

export interface FileSystemGenerationSessionStoreOptions {
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  staleLockMs?: number;
}

interface RequiredStoreOptions {
  lockTimeoutMs: number;
  lockRetryMs: number;
  staleLockMs: number;
}

const DEFAULT_OPTIONS: RequiredStoreOptions = {
  lockTimeoutMs: 2_000,
  lockRetryMs: 10,
  staleLockMs: 30_000
};

interface LockFile {
  token: string;
  modifiedAtMs: number;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function asStoreIoError(error: unknown, action: string): Error {
  if (error instanceof GenerationSessionStoreError) {
    return error;
  }
  return new GenerationSessionStoreError(
    "IO_ERROR",
    `Generation session store failed to ${action}`,
    { cause: error }
  );
}

function assertId(id: unknown): asserts id is string {
  if (
    typeof id !== "string"
    || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_ID",
      `Invalid generation session id: ${String(id)}`
    );
  }
}

function parseSession(value: unknown): GenerationSession {
  try {
    return GenerationSessionSchema.parse(value);
  } catch (error) {
    throw new GenerationSessionStoreError(
      "INVALID_SESSION",
      "Generation session state is invalid",
      { cause: error }
    );
  }
}

function sessionId(value: GenerationSession): string {
  const id: unknown = value.variables.runId;
  assertId(id);
  return id;
}

function validateExpectedRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new GenerationSessionStoreError(
      "INVALID_REVISION",
      `Invalid expected generation revision: ${String(revision)}`
    );
  }
}

function validateInitialRevision(session: GenerationSession): void {
  if (session.revision !== 0) {
    throw new GenerationSessionStoreError(
      "INVALID_REVISION",
      "A new generation session must start at revision 0"
    );
  }
}

function validateNextRevision(
  id: string,
  expectedRevision: number,
  next: GenerationSession
): void {
  validateExpectedRevision(expectedRevision);
  if (sessionId(next) !== id) {
    throw new GenerationSessionStoreError(
      "INVALID_ID",
      "Updated generation session id does not match the requested id"
    );
  }
  if (next.revision !== expectedRevision + 1) {
    throw new GenerationSessionStoreError(
      "INVALID_REVISION",
      "Next generation revision must increment expectedRevision by exactly one"
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function requireRealDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new GenerationSessionStoreError(
      "IO_ERROR",
      `Generation store path is not a real directory: ${path}`
    );
  }
}

async function createOrRequireDirectory(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw error;
    }
  }
  await requireRealDirectory(path);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalizeEvidence(
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
      return value.map((item) => canonicalizeEvidence(item, ancestors));
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
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [
          key,
          canonicalizeEvidence(
            (value as Record<string, unknown>)[key],
            ancestors
          )
        ])
    );
  } finally {
    ancestors.delete(value);
  }
}

function validateEvidencePath(relativePath: string): string[] {
  if (
    relativePath.length === 0
    || relativePath.includes("\\")
    || relativePath.includes("\0")
    || isAbsolute(relativePath)
    || posix.isAbsolute(relativePath)
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_EVIDENCE_PATH",
      `Invalid generation evidence path: ${relativePath}`
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
      `Invalid generation evidence path: ${relativePath}`
    );
  }
  return segments;
}

function assertContained(
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

async function readStateFromDirectory(
  directory: string
): Promise<GenerationSession> {
  await requireRealDirectory(directory);
  const statePath = join(directory, "state.json");
  let text: string;
  try {
    const handle = await open(
      statePath,
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof GenerationSessionStoreError) {
      throw error;
    }
    throw new GenerationSessionStoreError(
      "INVALID_SESSION",
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

async function readBoundState(
  directory: string,
  id: string
): Promise<GenerationSession> {
  const session = await readStateFromDirectory(directory);
  if (sessionId(session) !== id) {
    throw new GenerationSessionStoreError(
      "INVALID_SESSION",
      "Persisted generation session id does not match its directory"
    );
  }
  return session;
}

async function writeStateAtomically(
  directory: string,
  session: GenerationSession
): Promise<void> {
  const statePath = join(directory, "state.json");
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
    await rename(temporaryPath, statePath);
    await syncDirectory(directory);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class FileSystemGenerationSessionStore
implements GenerationSessionStore {
  private readonly projectRoot: string;
  private readonly generationRoot: string;
  private readonly options: RequiredStoreOptions;

  public constructor(
    projectRoot: string,
    options: FileSystemGenerationSessionStoreOptions = {}
  ) {
    this.projectRoot = resolve(projectRoot);
    this.generationRoot = join(
      this.projectRoot,
      ".taphound",
      "generations"
    );
    this.options = {
      lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_OPTIONS.lockTimeoutMs,
      lockRetryMs: options.lockRetryMs ?? DEFAULT_OPTIONS.lockRetryMs,
      staleLockMs: options.staleLockMs ?? DEFAULT_OPTIONS.staleLockMs
    };
  }

  public readonly create = async (
    input: GenerationSession
  ): Promise<void> => {
    const id = sessionId(input);
    const session = parseSession(input);
    validateInitialRevision(session);
    await this.ensureGenerationRoot();

    await this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      const finalDirectory = this.finalDirectory(id);
      if (
        await pathExists(activeDirectory)
        || await pathExists(finalDirectory)
      ) {
        throw new GenerationSessionStoreError(
          "SESSION_ALREADY_EXISTS",
          `Generation session already exists: ${id}`
        );
      }

      await mkdir(activeDirectory);
      try {
        await writeStateAtomically(activeDirectory, session);
      } catch (error) {
        await rm(activeDirectory).catch(() => undefined);
        throw error;
      }
    });
  };

  public readonly read = async (id: string): Promise<GenerationSession> => {
    assertId(id);
    await this.ensureGenerationRoot();
    const finalDirectory = this.finalDirectory(id);
    if (await pathExists(finalDirectory)) {
      return readBoundState(finalDirectory, id);
    }
    const activeDirectory = this.activeDirectory(id);
    if (await pathExists(activeDirectory)) {
      return readBoundState(activeDirectory, id);
    }
    throw new GenerationSessionStoreError(
      "SESSION_NOT_FOUND",
      `Generation session does not exist: ${id}`
    );
  };

  public readonly update = async (
    id: string,
    expectedRevision: number,
    input: GenerationSession
  ): Promise<void> => {
    assertId(id);
    const next = parseSession(input);
    validateNextRevision(id, expectedRevision, next);
    await this.ensureGenerationRoot();

    await this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      if (!await pathExists(activeDirectory)) {
        if (await pathExists(this.finalDirectory(id))) {
          throw new GenerationSessionStoreError(
            "SESSION_PUBLISHED",
            `Published generation session cannot be updated: ${id}`
          );
        }
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }

      const current = await readBoundState(activeDirectory, id);
      if (current.revision !== expectedRevision) {
        throw new GenerationSessionStoreError(
          "REVISION_CONFLICT",
          `Expected generation revision ${String(expectedRevision)}, found ${
            String(current.revision)
          }`
        );
      }
      await writeStateAtomically(activeDirectory, next);
    });
  };

  public readonly writeEvidence = async (
    id: string,
    relativePath: string,
    value: unknown
  ): Promise<void> => {
    assertId(id);
    const segments = validateEvidencePath(relativePath);
    const canonicalValue = canonicalizeEvidence(value);
    await this.ensureGenerationRoot();

    await this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      if (!await pathExists(activeDirectory)) {
        if (await pathExists(this.finalDirectory(id))) {
          throw new GenerationSessionStoreError(
            "SESSION_PUBLISHED",
            `Published generation session cannot accept evidence: ${id}`
          );
        }
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }
      await requireRealDirectory(activeDirectory);

      let parent = activeDirectory;
      for (const segment of segments.slice(0, -1)) {
        parent = join(parent, segment);
        try {
          await createOrRequireDirectory(parent);
        } catch (error) {
          throw new GenerationSessionStoreError(
            "INVALID_EVIDENCE_PATH",
            `Evidence parent is not a safe directory: ${relativePath}`,
            { cause: error }
          );
        }
      }
      const realActive = await realpath(activeDirectory);
      const realParent = await realpath(parent);
      assertContained(realActive, realParent, true);

      const outputPath = join(parent, segments.at(-1) as string);
      assertContained(activeDirectory, outputPath);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(
          outputPath,
          constants.O_WRONLY
            | constants.O_CREAT
            | constants.O_EXCL
            | constants.O_NOFOLLOW,
          0o600
        );
        await handle.writeFile(
          serializeJson(canonicalValue),
          "utf8"
        );
        await handle.sync();
        await handle.close();
        handle = undefined;
        await syncDirectory(parent);
      } catch (error) {
        if (handle !== undefined) {
          await handle.close().catch(() => undefined);
        }
        if (isNodeError(error) && error.code === "EEXIST") {
          throw new GenerationSessionStoreError(
            "EVIDENCE_ALREADY_EXISTS",
            `Generation evidence already exists: ${relativePath}`,
            { cause: error }
          );
        }
        throw error;
      }
    });
  };

  public readonly publish = async (id: string): Promise<string> => {
    assertId(id);
    await this.ensureGenerationRoot();
    return this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      const finalDirectory = this.finalDirectory(id);
      const activeExists = await pathExists(activeDirectory);
      const finalExists = await pathExists(finalDirectory);

      if (finalExists && !activeExists) {
        const state = await readBoundState(finalDirectory, id);
        this.assertPublishable(state);
        return finalDirectory;
      }
      if (finalExists) {
        throw new GenerationSessionStoreError(
          "PUBLISH_DESTINATION_EXISTS",
          `Generation publish destination already exists: ${finalDirectory}`
        );
      }
      if (!activeExists) {
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }

      const state = await readBoundState(activeDirectory, id);
      this.assertPublishable(state);
      try {
        await rename(activeDirectory, finalDirectory);
      } catch (error) {
        if (
          isNodeError(error)
          && (
            error.code === "EEXIST"
            || error.code === "ENOTEMPTY"
          )
        ) {
          throw new GenerationSessionStoreError(
            "PUBLISH_DESTINATION_EXISTS",
            `Generation publish destination already exists: ${finalDirectory}`,
            { cause: error }
          );
        }
        throw error;
      }
      await syncDirectory(this.generationRoot);
      return finalDirectory;
    });
  };

  private readonly ensureGenerationRoot = async (): Promise<void> => {
    try {
      await requireRealDirectory(this.projectRoot);
      const taphoundDirectory = join(this.projectRoot, ".taphound");
      await createOrRequireDirectory(taphoundDirectory);
      await createOrRequireDirectory(this.generationRoot);
    } catch (error) {
      throw asStoreIoError(error, "initialize its generation directory");
    }
  };

  private readonly activeDirectory = (id: string): string => (
    join(this.generationRoot, `.${id}.work`)
  );

  private readonly finalDirectory = (id: string): string => (
    join(this.generationRoot, id)
  );

  private readonly lockPath = (id: string): string => (
    join(this.generationRoot, `.${id}.lock`)
  );

  private readonly withLock = async <T>(
    id: string,
    operation: () => Promise<T>
  ): Promise<T> => {
    const token = randomUUID();
    try {
      await this.acquireLock(id, token);
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
    token: string
  ): Promise<void> => {
    const lockPath = this.lockPath(id);
    const deadline = Date.now() + this.options.lockTimeoutMs;
    for (;;) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(token, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw error;
        }
      }

      await this.removeStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new GenerationSessionStoreError(
          "LOCK_TIMEOUT",
          `Timed out acquiring generation session lock: ${id}`
        );
      }
      await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, this.options.lockRetryMs);
      });
    }
  };

  private readonly removeStaleLock = async (
    lockPath: string
  ): Promise<void> => {
    try {
      const observed = await this.readLockFile(lockPath);
      if (
        Date.now() - observed.modifiedAtMs >= this.options.staleLockMs
      ) {
        const current = await this.readLockFile(lockPath);
        if (current.token === observed.token) {
          await rm(lockPath);
        }
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
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
      const current = await this.readLockFile(lockPath);
      if (current.token === token) {
        await rm(lockPath);
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  };

  private readonly readLockFile = async (
    lockPath: string
  ): Promise<LockFile> => {
    const handle = await open(
      lockPath,
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const [token, stats] = await Promise.all([
        handle.readFile("utf8"),
        handle.stat()
      ]);
      return {
        token,
        modifiedAtMs: stats.mtimeMs
      };
    } finally {
      await handle.close();
    }
  };

  private assertPublishable(session: GenerationSession): void {
    if (
      session.verification.status !== "passed"
      || session.publication.status !== "published"
      || session.inFlight !== null
      || session.pendingConfirmation !== null
    ) {
      throw new GenerationSessionStoreError(
        "SESSION_NOT_PUBLISHABLE",
        "Generation session is not ready to publish"
      );
    }
  }
}
