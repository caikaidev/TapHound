import { randomUUID } from "node:crypto";
import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  posix,
  relative,
  resolve
} from "node:path";

import {
  GenerationInFlightSchema,
  GenerationSessionSchema,
  generationCoreIdentity,
  type GenerationInFlight,
  type GenerationSession
} from "../../domain/generation.js";
import {
  GenerationSessionStoreError,
  type GenerationSessionStore
} from "../../ports/generation-session-store.js";

export interface FileSystemGenerationSessionStoreOptions {
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  hooks?: FileSystemGenerationSessionStoreHooks;
}

export interface FileSystemGenerationSessionStoreHooks {
  beforeLockStagingWrite?: () => Promise<void> | void;
  beforeLockInstall?: () => Promise<void> | void;
  afterLockTombstoneRename?: () => Promise<void> | void;
  afterStateOpen?: () => Promise<void> | void;
  beforeStateRename?: () => Promise<void> | void;
  beforePublishRename?: () => Promise<void> | void;
  beforeEvidenceInstall?: () => Promise<void> | void;
  afterEvidenceInstall?: () => Promise<void> | void;
  afterDirectorySync?: (path: string) => Promise<void> | void;
}

interface RequiredStoreOptions {
  lockTimeoutMs: number;
  lockRetryMs: number;
}

const DEFAULT_OPTIONS: RequiredStoreOptions = {
  lockTimeoutMs: 2_000,
  lockRetryMs: 10
};

const HOOK_NAMES = [
  "beforeLockStagingWrite",
  "beforeLockInstall",
  "afterLockTombstoneRename",
  "afterStateOpen",
  "beforeStateRename",
  "beforePublishRename",
  "beforeEvidenceInstall",
  "afterEvidenceInstall",
  "afterDirectorySync"
] as const satisfies readonly (keyof FileSystemGenerationSessionStoreHooks)[];

function parseStoreConfiguration(
  projectRoot: unknown,
  options: unknown
): {
  projectRoot: string;
  options: RequiredStoreOptions;
  hooks: FileSystemGenerationSessionStoreHooks;
} {
  try {
    if (typeof projectRoot !== "string") {
      throw new TypeError("projectRoot must be a string");
    }
    if (options === null || typeof options !== "object") {
      throw new TypeError("options must be an object");
    }
    const lockTimeoutInput = Reflect.get(options, "lockTimeoutMs") as unknown;
    const lockRetryInput = Reflect.get(options, "lockRetryMs") as unknown;
    const lockTimeoutMs = lockTimeoutInput
      ?? DEFAULT_OPTIONS.lockTimeoutMs;
    const lockRetryMs = lockRetryInput ?? DEFAULT_OPTIONS.lockRetryMs;
    if (
      !Number.isSafeInteger(lockTimeoutMs)
      || (lockTimeoutMs as number) < 0
      || !Number.isSafeInteger(lockRetryMs)
      || (lockRetryMs as number) < 0
    ) {
      throw new TypeError("lock timing options must be safe integers");
    }

    const hooksInput = Reflect.get(options, "hooks") as unknown;
    const hooks: FileSystemGenerationSessionStoreHooks = {};
    if (hooksInput !== undefined) {
      if (hooksInput === null || typeof hooksInput !== "object") {
        throw new TypeError("hooks must be an object");
      }
      for (const name of HOOK_NAMES) {
        const hook = Reflect.get(hooksInput, name) as unknown;
        if (hook !== undefined && typeof hook !== "function") {
          throw new TypeError(`${name} must be a function`);
        }
        if (hook !== undefined) {
          hooks[name] = hook as never;
        }
      }
    }
    return {
      projectRoot: resolve(projectRoot),
      options: {
        lockTimeoutMs: lockTimeoutMs as number,
        lockRetryMs: lockRetryMs as number
      },
      hooks
    };
  } catch (error) {
    throw new GenerationSessionStoreError(
      "IO_ERROR",
      "Generation session store configuration is invalid",
      { cause: error }
    );
  }
}

interface LockOwner {
  pid: number;
  token: string;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface DirectoryEvidence {
  path: string;
  canonicalPath: string;
  identity: FileIdentity;
}

interface StoreDirectoryEvidence {
  path: string;
  canonicalPath: string;
  identity: FileIdentity;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function captureStoreDirectory(
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

async function verifyStoreDirectory(
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

async function captureStoreFile(path: string): Promise<FileIdentity> {
  const stats = await lstat(path, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new GenerationSessionStoreError(
      "IO_ERROR",
      `Generation store path is not a real file: ${path}`
    );
  }
  return { dev: stats.dev, ino: stats.ino };
}

async function captureOptionalStoreFile(
  path: string
): Promise<FileIdentity | null> {
  try {
    return await captureStoreFile(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function verifyOptionalStoreFile(
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
      "Invalid generation session id"
    );
  }
}

function parseSession(
  value: unknown,
  classifyInvalidId = false
): GenerationSession {
  try {
    return GenerationSessionSchema.parse(value);
  } catch (error) {
    if (classifyInvalidId && value !== null && typeof value === "object") {
      try {
        const id = Reflect.get(value, "id") as unknown;
        if (typeof id === "string") {
          assertId(id);
        }
      } catch (idError) {
        if (idError instanceof GenerationSessionStoreError) {
          throw idError;
        }
      }
    }
    throw new GenerationSessionStoreError(
      "INVALID_SESSION",
      "Generation session state is invalid",
      { cause: error }
    );
  }
}

function sessionId(value: GenerationSession): string {
  const id: unknown = value.id;
  assertId(id);
  return id;
}

function validateExpectedRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new GenerationSessionStoreError(
      "INVALID_REVISION",
      "Invalid expected generation revision"
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
  if (expectedRevision === Number.MAX_SAFE_INTEGER) {
    throw new GenerationSessionStoreError(
      "INVALID_REVISION",
      "Generation revision cannot increment beyond Number.MAX_SAFE_INTEGER"
    );
  }
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

function parseInFlight(value: unknown): GenerationInFlight {
  try {
    return GenerationInFlightSchema.parse(value);
  } catch (error) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Expected inFlight record is invalid",
      { cause: error }
    );
  }
}

function sameInFlight(
  left: GenerationSession["inFlight"],
  right: GenerationSession["inFlight"]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function transitionStableState(
  session: GenerationSession
): Record<string, unknown> {
  return {
    version: session.version,
    id: session.id,
    bindings: session.bindings,
    target: session.target,
    variables: session.variables,
    candidateSteps: session.candidateSteps,
    pendingConfirmation: session.pendingConfirmation,
    verification: session.verification,
    publication: session.publication
  };
}

function assertCoreIdentityPreserved(
  current: GenerationSession,
  next: GenerationSession
): void {
  if (
    JSON.stringify(generationCoreIdentity(current))
    !== JSON.stringify(generationCoreIdentity(next))
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Generation Core identity is immutable"
    );
  }
}

function assertLatestSnapshotPreserved(
  current: GenerationSession,
  next: GenerationSession
): void {
  if (current.bindings.snapshotHash !== next.bindings.snapshotHash) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Latest snapshot may only change through commitSnapshot"
    );
  }
}

function assertSnapshotTransition(
  current: GenerationSession,
  next: GenerationSession
): void {
  assertCoreIdentityPreserved(current, next);
  const currentBindings = {
    projectHash: current.bindings.projectHash,
    configHash: current.bindings.configHash,
    contextHash: current.bindings.contextHash
  };
  const { snapshotHash: nextSnapshotHash, ...nextBindings } = next.bindings;
  if (
    current.state !== "active"
    || current.inFlight !== null
    || current.pendingConfirmation !== null
    || next.state !== "active"
    || next.inFlight !== null
    || next.pendingConfirmation !== null
    || nextSnapshotHash === null
    || JSON.stringify(currentBindings) !== JSON.stringify(nextBindings)
    || JSON.stringify({
      ...transitionStableState(current),
      bindings: undefined
    }) !== JSON.stringify({
      ...transitionStableState(next),
      bindings: undefined
    })
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Snapshot commit may only replace the active snapshot binding"
    );
  }
}

function assertOrdinaryTransition(
  current: GenerationSession,
  next: GenerationSession
): void {
  assertCoreIdentityPreserved(current, next);
  assertLatestSnapshotPreserved(current, next);
  if (current.state === "recoveryRequired") {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Recovery-required state must use the explicit recovery transition"
    );
  }
  if (
    JSON.stringify(current.pendingConfirmation)
    !== JSON.stringify(next.pendingConfirmation)
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Pending confirmation must use the explicit confirmation transition"
    );
  }
  const stableStateMatches = JSON.stringify(transitionStableState(current))
    === JSON.stringify(transitionStableState(next));
  if (current.inFlight !== null) {
    if (
      next.state === "recoveryRequired"
      && sameInFlight(current.inFlight, next.inFlight)
      && stableStateMatches
    ) {
      return;
    }
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Persisted inFlight may only be marked recoveryRequired without mutation"
    );
  }

  if (
    next.state === "recoveryRequired"
    || (next.inFlight !== null && !stableStateMatches)
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Starting inFlight cannot mutate candidate or result state"
    );
  }
}

function confirmationStableState(
  session: GenerationSession
): Record<string, unknown> {
  const stable = transitionStableState(session);
  return { ...stable, pendingConfirmation: undefined };
}

function assertConfirmationTransition(
  current: GenerationSession,
  next: GenerationSession
): void {
  assertCoreIdentityPreserved(current, next);
  assertLatestSnapshotPreserved(current, next);
  if (
    current.state !== "active"
    || next.state !== "active"
    || current.inFlight !== null
    || next.inFlight !== null
    || JSON.stringify(confirmationStableState(current))
      !== JSON.stringify(confirmationStableState(next))
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Confirmation transition may only change pending confirmation state"
    );
  }

  const before = current.pendingConfirmation;
  const after = next.pendingConfirmation;
  if (before === null) {
    if (after !== null && after.status === "pending") {
      return;
    }
  } else if (after === null) {
    return;
  } else if (
    before.status === "pending"
    && after.status === "approved"
    && JSON.stringify({ ...before, status: undefined })
      === JSON.stringify({ ...after, status: undefined })
  ) {
    return;
  }
  throw new GenerationSessionStoreError(
    "INVALID_TRANSITION",
    "Invalid pending confirmation lifecycle transition"
  );
}

function assertRecoveryTransition(
  current: GenerationSession,
  next: GenerationSession
): void {
  assertCoreIdentityPreserved(current, next);
  assertLatestSnapshotPreserved(current, next);
  if (
    current.state !== "recoveryRequired"
    || current.inFlight === null
    || next.state !== "active"
    || next.inFlight !== null
    || JSON.stringify(transitionStableState(current))
      !== JSON.stringify(transitionStableState(next))
  ) {
    throw new GenerationSessionStoreError(
      "INVALID_TRANSITION",
      "Recovery must only clear preserved inFlight evidence and reactivate state"
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

async function createOrRequireDirectory(path: string): Promise<boolean> {
  let created = false;
  try {
    await mkdir(path);
    created = true;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw error;
    }
  }
  await requireRealDirectory(path);
  return created;
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

function canonicalizeEvidenceValue(
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
        .sort((left, right) => left.localeCompare(right))
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

function canonicalizeEvidence(value: unknown): unknown {
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

function validateEvidencePath(relativePath: unknown): string[] {
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

async function captureDirectoryEvidence(
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

async function verifyDirectoryEvidence(
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

async function fileIdentity(path: string): Promise<FileIdentity> {
  const stats = await lstat(path, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new GenerationSessionStoreError(
      "INVALID_EVIDENCE_PATH",
      `Evidence output is not a regular file: ${path}`
    );
  }
  return { dev: stats.dev, ino: stats.ino };
}

async function readStateFromDirectory(
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

async function readBoundState(
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

async function writeStateAtomically(
  directory: string,
  session: GenerationSession,
  sync: (path: string) => Promise<void> = syncDirectory,
  beforeRename?: () => Promise<void> | void,
  expectedDirectory?: StoreDirectoryEvidence
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

export class FileSystemGenerationSessionStore
implements GenerationSessionStore {
  private readonly projectRoot: string;
  private readonly generationRoot: string;
  private readonly locksRoot: string;
  private readonly options: RequiredStoreOptions;
  private readonly hooks: FileSystemGenerationSessionStoreHooks;

  public constructor(
    projectRoot: string,
    options: FileSystemGenerationSessionStoreOptions = {}
  ) {
    const configuration = parseStoreConfiguration(projectRoot, options);
    this.projectRoot = configuration.projectRoot;
    this.generationRoot = join(
      this.projectRoot,
      ".taphound",
      "generations"
    );
    this.locksRoot = join(this.generationRoot, ".locks");
    this.options = configuration.options;
    this.hooks = configuration.hooks;
  }

  public readonly create = async (
    input: GenerationSession
  ): Promise<void> => {
    const session = parseSession(input, true);
    const id = sessionId(session);
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
        const activeEvidence = await captureStoreDirectory(activeDirectory);
        await writeStateAtomically(
          activeDirectory,
          session,
          this.syncDirectory,
          this.hooks.beforeStateRename,
          activeEvidence
        );
        await this.syncDirectory(this.generationRoot);
      } catch (error) {
        await rm(activeDirectory).catch(() => undefined);
        throw error;
      }
    });
  };

  public readonly read = async (id: string): Promise<GenerationSession> => {
    assertId(id);
    await this.ensureGenerationRoot();
    return this.withLock(id, async () => {
      const finalDirectory = this.finalDirectory(id);
      if (await pathExists(finalDirectory)) {
        const finalEvidence = await captureStoreDirectory(finalDirectory);
        return readBoundState(
          finalDirectory,
          id,
          this.hooks.afterStateOpen,
          finalEvidence
        );
      }
      const activeDirectory = this.activeDirectory(id);
      if (await pathExists(activeDirectory)) {
        const activeEvidence = await captureStoreDirectory(activeDirectory);
        return readBoundState(
          activeDirectory,
          id,
          this.hooks.afterStateOpen,
          activeEvidence
        );
      }
      throw new GenerationSessionStoreError(
        "SESSION_NOT_FOUND",
        `Generation session does not exist: ${id}`
      );
    });
  };

  public readonly update = async (
    id: string,
    expectedRevision: number,
    input: GenerationSession
  ): Promise<void> => {
    assertId(id);
    const next = parseSession(input, true);
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

      const activeEvidence = await captureStoreDirectory(activeDirectory);
      const current = await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );
      if (current.revision !== expectedRevision) {
        throw new GenerationSessionStoreError(
          "REVISION_CONFLICT",
          `Expected generation revision ${String(expectedRevision)}, found ${
            String(current.revision)
          }`
        );
      }
      assertOrdinaryTransition(current, next);
      await writeStateAtomically(
        activeDirectory,
        next,
        this.syncDirectory,
        this.hooks.beforeStateRename,
        activeEvidence
      );
    });
  };

  public readonly commitSnapshot = async (
    id: string,
    expectedRevision: number,
    input: GenerationSession
  ): Promise<void> => {
    assertId(id);
    const next = parseSession(input, true);
    validateNextRevision(id, expectedRevision, next);
    await this.ensureGenerationRoot();

    await this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      if (!await pathExists(activeDirectory)) {
        if (await pathExists(this.finalDirectory(id))) {
          throw new GenerationSessionStoreError(
            "SESSION_PUBLISHED",
            `Published generation session cannot commit a snapshot: ${id}`
          );
        }
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }

      const activeEvidence = await captureStoreDirectory(activeDirectory);
      const current = await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );
      if (current.revision !== expectedRevision) {
        throw new GenerationSessionStoreError(
          "REVISION_CONFLICT",
          `Expected generation revision ${String(expectedRevision)}, found ${
            String(current.revision)
          }`
        );
      }
      assertSnapshotTransition(current, next);
      await writeStateAtomically(
        activeDirectory,
        next,
        this.syncDirectory,
        this.hooks.beforeStateRename,
        activeEvidence
      );
    });
  };

  public readonly updateConfirmation = async (
    id: string,
    expectedRevision: number,
    input: GenerationSession
  ): Promise<void> => {
    assertId(id);
    const next = parseSession(input, true);
    validateNextRevision(id, expectedRevision, next);
    await this.ensureGenerationRoot();

    await this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      if (!await pathExists(activeDirectory)) {
        if (await pathExists(this.finalDirectory(id))) {
          throw new GenerationSessionStoreError(
            "SESSION_PUBLISHED",
            `Published generation session cannot update confirmation: ${id}`
          );
        }
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }

      const activeEvidence = await captureStoreDirectory(activeDirectory);
      const current = await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );
      if (current.revision !== expectedRevision) {
        throw new GenerationSessionStoreError(
          "REVISION_CONFLICT",
          `Expected generation revision ${String(expectedRevision)}, found ${
            String(current.revision)
          }`
        );
      }
      assertConfirmationTransition(current, next);
      await writeStateAtomically(
        activeDirectory,
        next,
        this.syncDirectory,
        this.hooks.beforeStateRename,
        activeEvidence
      );
    });
  };

  public readonly completeStep = async (
    id: string,
    expectedRevision: number,
    expectedInFlightInput: GenerationInFlight,
    input: GenerationSession
  ): Promise<void> => {
    assertId(id);
    const expectedInFlight = parseInFlight(expectedInFlightInput);
    const next = parseSession(input, true);
    validateNextRevision(id, expectedRevision, next);
    await this.ensureGenerationRoot();

    await this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      if (!await pathExists(activeDirectory)) {
        if (await pathExists(this.finalDirectory(id))) {
          throw new GenerationSessionStoreError(
            "SESSION_PUBLISHED",
            `Published generation session cannot complete a step: ${id}`
          );
        }
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }

      const activeEvidence = await captureStoreDirectory(activeDirectory);
      const current = await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );
      if (current.revision !== expectedRevision) {
        throw new GenerationSessionStoreError(
          "REVISION_CONFLICT",
          `Expected generation revision ${String(expectedRevision)}, found ${
            String(current.revision)
          }`
        );
      }
      if (
        current.state !== "active"
        || current.inFlight === null
        || !sameInFlight(current.inFlight, expectedInFlight)
        || next.state !== "active"
        || next.inFlight !== null
      ) {
        throw new GenerationSessionStoreError(
          "INVALID_TRANSITION",
          "Step completion must clear the matching active inFlight record"
        );
      }
      assertCoreIdentityPreserved(current, next);
      assertLatestSnapshotPreserved(current, next);
      const candidateAppended = next.candidateSteps.length
        === current.candidateSteps.length + 1
        && JSON.stringify(next.candidateSteps.slice(
          0,
          current.candidateSteps.length
        )) === JSON.stringify(current.candidateSteps);
      const currentStable = {
        ...transitionStableState(current),
        candidateSteps: undefined,
        pendingConfirmation: undefined
      };
      const nextStable = {
        ...transitionStableState(next),
        candidateSteps: undefined,
        pendingConfirmation: undefined
      };
      if (
        !candidateAppended
        || current.pendingConfirmation !== null
        || next.pendingConfirmation !== null
        || JSON.stringify(currentStable) !== JSON.stringify(nextStable)
      ) {
        throw new GenerationSessionStoreError(
          "INVALID_TRANSITION",
          "Step completion must append exactly one successful Journey step"
        );
      }
      await writeStateAtomically(
        activeDirectory,
        next,
        this.syncDirectory,
        this.hooks.beforeStateRename,
        activeEvidence
      );
    });
  };

  public readonly recover = async (
    id: string,
    expectedRevision: number,
    input: GenerationSession
  ): Promise<void> => {
    assertId(id);
    const next = parseSession(input, true);
    validateNextRevision(id, expectedRevision, next);
    await this.ensureGenerationRoot();

    await this.withLock(id, async () => {
      const activeDirectory = this.activeDirectory(id);
      if (!await pathExists(activeDirectory)) {
        if (await pathExists(this.finalDirectory(id))) {
          throw new GenerationSessionStoreError(
            "SESSION_PUBLISHED",
            `Published generation session cannot be recovered: ${id}`
          );
        }
        throw new GenerationSessionStoreError(
          "SESSION_NOT_FOUND",
          `Generation session does not exist: ${id}`
        );
      }

      const activeEvidence = await captureStoreDirectory(activeDirectory);
      const current = await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );
      if (current.revision !== expectedRevision) {
        throw new GenerationSessionStoreError(
          "REVISION_CONFLICT",
          `Expected generation revision ${String(expectedRevision)}, found ${
            String(current.revision)
          }`
        );
      }
      assertRecoveryTransition(current, next);
      await writeStateAtomically(
        activeDirectory,
        next,
        this.syncDirectory,
        this.hooks.beforeStateRename,
        activeEvidence
      );
    });
  };

  public readonly writeEvidence = async (
    id: string,
    relativePath: string,
    value: unknown
  ): Promise<void> => {
    const canonicalValue = canonicalizeEvidence(value);
    await this.produceEvidence(id, relativePath, async (temporaryPath) => {
      const handle = await open(
        temporaryPath,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_EXCL
          | constants.O_NOFOLLOW,
        0o600
      );
      try {
        await handle.writeFile(serializeJson(canonicalValue), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  };

  public readonly produceEvidence = async (
    id: string,
    relativePath: string,
    produce: (temporaryPath: string) => Promise<void>
  ): Promise<void> => {
    assertId(id);
    const segments = validateEvidencePath(relativePath);
    if (typeof produce !== "function") {
      throw new GenerationSessionStoreError(
        "INVALID_EVIDENCE",
        "Evidence producer must be a function"
      );
    }
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
      const activeEvidence = await captureStoreDirectory(activeDirectory);
      await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );

      let parent = activeDirectory;
      const directoryEvidence: DirectoryEvidence[] = [
        activeEvidence
      ];
      for (const segment of segments.slice(0, -1)) {
        await verifyStoreDirectory(activeEvidence);
        const parentBeforeCreation = parent;
        parent = join(parentBeforeCreation, segment);
        try {
          const created = await createOrRequireDirectory(parent);
          if (created) {
            await this.syncDirectory(parent);
            await this.syncDirectory(parentBeforeCreation);
          }
          directoryEvidence.push(await captureDirectoryEvidence(parent));
        } catch (error) {
          throw new GenerationSessionStoreError(
            "INVALID_EVIDENCE_PATH",
            `Evidence parent is not a safe directory: ${relativePath}`,
            { cause: error }
          );
        }
      }
      const realActive = directoryEvidence[0]?.canonicalPath;
      if (realActive === undefined) {
        throw new GenerationSessionStoreError(
          "INVALID_EVIDENCE_PATH",
          "Generation active directory identity is unavailable"
        );
      }
      await verifyDirectoryEvidence(realActive, directoryEvidence);

      const outputPath = join(parent, segments.at(-1) as string);
      assertContained(activeDirectory, outputPath);
      const temporaryPath = join(
        activeDirectory,
        `.producer-${randomUUID()}.tmp`
      );
      let installed = false;
      let committed = false;
      try {
        await verifyStoreDirectory(activeEvidence);
        await produce(temporaryPath);
        const temporaryIdentity = await fileIdentity(temporaryPath);
        const handle = await open(
          temporaryPath,
          constants.O_RDONLY | constants.O_NOFOLLOW
        );
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        await this.hooks.beforeEvidenceInstall?.();
        await verifyDirectoryEvidence(realActive, directoryEvidence);
        await link(temporaryPath, outputPath);
        installed = true;
        const installedIdentity = await fileIdentity(outputPath);
        await verifyDirectoryEvidence(realActive, directoryEvidence);
        if (
          installedIdentity.dev !== temporaryIdentity.dev
          || installedIdentity.ino !== temporaryIdentity.ino
        ) {
          throw new GenerationSessionStoreError(
            "INVALID_EVIDENCE_PATH",
            `Evidence output identity changed: ${relativePath}`
          );
        }
        await this.syncDirectory(parent);
        committed = true;
        await this.hooks.afterEvidenceInstall?.();
      } catch (error) {
        if (installed && !committed) {
          try {
            const currentIdentity = await fileIdentity(outputPath);
            const temporaryIdentity = await fileIdentity(temporaryPath);
            if (
              currentIdentity.dev === temporaryIdentity.dev
              && currentIdentity.ino === temporaryIdentity.ino
            ) {
              await unlink(outputPath);
              await this.syncDirectory(parent);
            }
          } catch {
            // Preserve any path that cannot be proven to be our own link.
          }
        }
        if (isNodeError(error) && error.code === "EEXIST") {
          throw new GenerationSessionStoreError(
            "EVIDENCE_ALREADY_EXISTS",
            `Generation evidence already exists: ${relativePath}`,
            { cause: error }
          );
        }
        throw error;
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
    });
  };

  public readonly publish = async (id: string): Promise<string> => {
    assertId(id);
    await this.ensureGenerationRoot();
    return this.withLock(id, async () => {
      const generationRootEvidence = await captureStoreDirectory(
        this.generationRoot
      );
      const activeDirectory = this.activeDirectory(id);
      const finalDirectory = this.finalDirectory(id);
      const activeExists = await pathExists(activeDirectory);
      const finalExists = await pathExists(finalDirectory);

      if (finalExists && !activeExists) {
        const finalEvidence = await captureStoreDirectory(finalDirectory);
        const state = await readBoundState(
          finalDirectory,
          id,
          this.hooks.afterStateOpen,
          finalEvidence
        );
        this.assertPublishable(state);
        await this.syncDirectory(this.generationRoot);
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

      const activeEvidence = await captureStoreDirectory(activeDirectory);
      const state = await readBoundState(
        activeDirectory,
        id,
        this.hooks.afterStateOpen,
        activeEvidence
      );
      this.assertPublishable(state);
      try {
        await this.hooks.beforePublishRename?.();
        await verifyStoreDirectory(generationRootEvidence);
        await verifyStoreDirectory(activeEvidence);
        await rename(activeDirectory, finalDirectory);
        const finalEvidence = await captureStoreDirectory(finalDirectory);
        if (!sameIdentity(activeEvidence.identity, finalEvidence.identity)) {
          throw new GenerationSessionStoreError(
            "IO_ERROR",
            "Published generation bundle identity changed"
          );
        }
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
      await this.syncDirectory(this.generationRoot);
      return finalDirectory;
    });
  };

  private readonly ensureGenerationRoot = async (): Promise<void> => {
    try {
      await requireRealDirectory(this.projectRoot);
      const taphoundDirectory = join(this.projectRoot, ".taphound");
      if (await createOrRequireDirectory(taphoundDirectory)) {
        await this.syncDirectory(this.projectRoot);
      }
      if (await createOrRequireDirectory(this.generationRoot)) {
        await this.syncDirectory(taphoundDirectory);
      }
      if (await createOrRequireDirectory(this.locksRoot)) {
        await this.syncDirectory(this.generationRoot);
      }
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
    join(this.locksRoot, `${id}.lock`)
  );

  private readonly syncDirectory = async (path: string): Promise<void> => {
    await syncDirectory(path);
    await this.hooks.afterDirectorySync?.(path);
  };

  private readonly withLock = async <T>(
    id: string,
    operation: () => Promise<T>
  ): Promise<T> => {
    const token = randomUUID();
    let generationRootEvidence: StoreDirectoryEvidence;
    let locksRootEvidence: StoreDirectoryEvidence;
    try {
      generationRootEvidence = await captureStoreDirectory(
        this.generationRoot
      );
      locksRootEvidence = await captureStoreDirectory(this.locksRoot);
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
    const deadline = Date.now() + this.options.lockTimeoutMs;
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
        setTimeout(resolveDelay, this.options.lockRetryMs);
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
      this.locksRoot,
      `.${id}.lock.acquire-${randomUUID()}.tmp`
    );
    try {
      const handle = await open(stagingPath, "wx", 0o600);
      try {
        await this.hooks.beforeLockStagingWrite?.();
        await handle.writeFile(serializeJson(owner), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.hooks.beforeLockInstall?.();
      await verifyStoreDirectory(generationRootEvidence);
      await verifyStoreDirectory(locksRootEvidence);
      try {
        await link(stagingPath, lockPath);
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") {
          return false;
        }
        throw error;
      }
      try {
        await this.syncDirectory(this.locksRoot);
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
        this.locksRoot,
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
      await this.hooks.afterLockTombstoneRename?.();
      await unlink(tombstone);
      await this.syncDirectory(this.locksRoot);
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
      const identity = await this.fileIdentity(lockPath);
      const current = await this.readLockOwner(lockPath);
      if (current?.pid === process.pid && current.token === token) {
        const tombstone = join(
          this.locksRoot,
          `.${id}.lock.release-${randomUUID()}`
        );
        await rename(lockPath, tombstone);
        const movedIdentity = await this.fileIdentity(tombstone);
        if (
          movedIdentity.dev === identity.dev
          && movedIdentity.ino === identity.ino
        ) {
          await unlink(tombstone);
          await this.syncDirectory(this.locksRoot);
        } else {
          await rename(tombstone, lockPath).catch(() => undefined);
        }
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
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
      return !isNodeError(error) || error.code !== "ESRCH";
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
