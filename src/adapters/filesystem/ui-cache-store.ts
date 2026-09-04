import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import {
  CachedFlowFragmentSchema,
  CachedScreenModelSchema,
  FlowVerificationReceiptSchema,
  flowFragmentCacheKey,
  screenModelCacheKey,
  type CachedFlowFragment,
  type CachedScreenModel,
  type FlowVerificationReceipt
} from "../../domain/ui-cache.js";
import { UI_CACHE_DIR } from "../../domain/workspace.js";
import type {
  UiCacheReadResult,
  UiCacheStatus,
  UiCacheStore
} from "../../ports/ui-cache-store.js";

const CACHE_SCHEMA_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const SHA256_FILE = /^[a-f\d]{64}\.json$/;

const EnvelopeSchema = z.strictObject({
  cacheSchemaVersion: z.literal(CACHE_SCHEMA_VERSION),
  kind: z.enum(["screen", "flow"]),
  lastAccessedAt: z.iso.datetime(),
  value: z.unknown()
});

interface CacheFile {
  path: string;
  bytes: number;
  mtimeMs: number;
}

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (
    fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot)
  );
}

function isMissing(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isUnknownSchema(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && "cacheSchemaVersion" in value
    && (value as { cacheSchemaVersion?: unknown }).cacheSchemaVersion
      !== CACHE_SCHEMA_VERSION;
}

export interface FileSystemUiCacheStoreOptions {
  maxEntries?: number | undefined;
  maxBytes?: number | undefined;
  now?: (() => Date) | undefined;
}

export class FileSystemUiCacheStore implements UiCacheStore {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private queue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly projectRoot: string,
    options: FileSystemUiCacheStoreOptions = {}
  ) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = options.now ?? (() : Date => new Date());
  }

  public readScreen(
    key: string
  ): Promise<UiCacheReadResult<CachedScreenModel>> {
    return this.serialized(() => this.read("screen", key, CachedScreenModelSchema));
  }

  public writeScreen(model: CachedScreenModel): Promise<string> {
    return this.serialized(async () => {
      const parsed = CachedScreenModelSchema.parse(model);
      const key = screenModelCacheKey(parsed);
      await this.write("screen", key, parsed);
      return key;
    });
  }

  public invalidateScreen(key: string): Promise<void> {
    return this.serialized(async () => {
      const path = await this.entryPath("screen", key, false);
      if (path !== undefined) await unlink(path).catch(() => undefined);
    });
  }

  public readFlow(
    name: string
  ): Promise<UiCacheReadResult<CachedFlowFragment>> {
    return this.serialized(() => this.read(
      "flow",
      flowFragmentCacheKey(name),
      CachedFlowFragmentSchema
    ));
  }

  public writeFlow(fragment: CachedFlowFragment): Promise<string> {
    return this.serialized(async () => {
      const parsed = CachedFlowFragmentSchema.parse(fragment);
      const key = flowFragmentCacheKey(parsed.name);
      await this.write("flow", key, parsed);
      return key;
    });
  }

  public addFlowVerification(
    name: string,
    receipt: FlowVerificationReceipt
  ): Promise<UiCacheReadResult<CachedFlowFragment>> {
    return this.serialized(async () => {
      const current = await this.readUnlocked(
        "flow",
        flowFragmentCacheKey(name),
        CachedFlowFragmentSchema
      );
      if (current.status === "miss") return current;
      const parsedReceipt = FlowVerificationReceiptSchema.parse(receipt);
      const next = CachedFlowFragmentSchema.parse({
        ...current.value,
        verifiedBuilds: [
          ...current.value.verifiedBuilds.filter((existing) => !(
            existing.appBuild.buildSha256 === parsedReceipt.appBuild.buildSha256
            && existing.environmentSha256 === parsedReceipt.environmentSha256
            && existing.uiBackend.configSha256
              === parsedReceipt.uiBackend.configSha256
          )),
          parsedReceipt
        ]
      });
      await this.writeUnlocked("flow", flowFragmentCacheKey(name), next);
      return { status: "hit", value: next };
    });
  }

  public status(): Promise<UiCacheStatus> {
    return this.serialized(async () => {
      const root = await this.cacheRoot(false);
      if (root === undefined) {
        return { directory: UI_CACHE_DIR, entries: 0, bytes: 0 };
      }
      const files = await this.cacheFiles(root);
      return {
        directory: UI_CACHE_DIR,
        entries: files.length,
        bytes: files.reduce((total, file) => total + file.bytes, 0)
      };
    });
  }

  public clear(): Promise<void> {
    return this.serialized(async () => {
      const root = await this.cacheRoot(false);
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async read<T>(
    kind: "screen" | "flow",
    key: string,
    schema: z.ZodType<T>
  ): Promise<UiCacheReadResult<T>> {
    return this.readUnlocked(kind, key, schema);
  }

  private async readUnlocked<T>(
    kind: "screen" | "flow",
    key: string,
    schema: z.ZodType<T>
  ): Promise<UiCacheReadResult<T>> {
    const path = await this.entryPath(kind, key, false);
    if (path === undefined) return { status: "miss", reason: "absent" };
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error) {
      return { status: "miss", reason: isMissing(error) ? "absent" : "corrupt" };
    }
    if (isUnknownSchema(raw)) return { status: "miss", reason: "unknownSchema" };
    const envelope = EnvelopeSchema.safeParse(raw);
    if (!envelope.success || envelope.data.kind !== kind) {
      return { status: "miss", reason: "corrupt" };
    }
    const value = schema.safeParse(envelope.data.value);
    if (!value.success) return { status: "miss", reason: "corrupt" };
    await this.atomicWrite(path, {
      ...envelope.data,
      lastAccessedAt: this.now().toISOString(),
      value: value.data
    }).catch(() => undefined);
    return { status: "hit", value: value.data };
  }

  private async write(
    kind: "screen" | "flow",
    key: string,
    value: unknown
  ): Promise<void> {
    await this.writeUnlocked(kind, key, value);
  }

  private async writeUnlocked(
    kind: "screen" | "flow",
    key: string,
    value: unknown
  ): Promise<void> {
    const path = await this.entryPath(kind, key, true);
    if (path === undefined) throw new Error("UI cache directory could not be created");
    await this.atomicWrite(path, {
      cacheSchemaVersion: CACHE_SCHEMA_VERSION,
      kind,
      lastAccessedAt: this.now().toISOString(),
      value
    });
    await this.evict();
  }

  private async cacheRoot(create: boolean): Promise<string | undefined> {
    const canonicalProject = await realpath(this.projectRoot);
    const candidate = resolve(canonicalProject, UI_CACHE_DIR, "v1");
    if (!contained(canonicalProject, candidate)) {
      throw new Error("UI cache directory escapes the project root");
    }
    const components = UI_CACHE_DIR.split("/").concat("v1");
    let current = canonicalProject;
    for (const component of components) {
      current = join(current, component);
      const details = await lstat(current).catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
      });
      if (details?.isSymbolicLink() === true) {
        throw new Error(`UI cache path is a symlink: ${current}`);
      }
      if (details === undefined) {
        if (!create) return undefined;
        await mkdir(current);
      } else if (!details.isDirectory()) {
        throw new Error(`UI cache path is not a directory: ${current}`);
      }
    }
    const canonicalCache = await realpath(candidate);
    if (!contained(canonicalProject, canonicalCache)) {
      throw new Error("UI cache directory escapes the project root");
    }
    return canonicalCache;
  }

  private async entryPath(
    kind: "screen" | "flow",
    key: string,
    create: boolean
  ): Promise<string | undefined> {
    if (!/^[a-f\d]{64}$/.test(key)) throw new Error("Invalid UI cache key");
    const root = await this.cacheRoot(create);
    if (root === undefined) return undefined;
    const directory = join(root, `${kind}s`);
    const details = await lstat(directory).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (details === undefined) {
      if (!create) return undefined;
      await mkdir(directory);
    } else if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error(`UI cache namespace is unsafe: ${directory}`);
    }
    const target = join(directory, `${key}.json`);
    if (!contained(root, target)) throw new Error("UI cache entry escapes cache root");
    return target;
  }

  private async atomicWrite(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    try {
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async cacheFiles(root: string): Promise<CacheFile[]> {
    const files: CacheFile[] = [];
    for (const namespace of ["screens", "flows"] as const) {
      const directory = join(root, namespace);
      const entries = await readdir(directory, { withFileTypes: true }).catch(
        (error: unknown) => {
          if (isMissing(error)) return [];
          throw error;
        }
      );
      for (const entry of entries) {
        if (!entry.isFile() || !SHA256_FILE.test(entry.name)) continue;
        const path = join(directory, entry.name);
        const details = await stat(path);
        files.push({ path, bytes: details.size, mtimeMs: details.mtimeMs });
      }
    }
    return files;
  }

  private async evict(): Promise<void> {
    const root = await this.cacheRoot(false);
    if (root === undefined) return;
    const files = (await this.cacheFiles(root)).sort(
      (left, right) => left.mtimeMs - right.mtimeMs
    );
    let totalBytes = files.reduce((total, file) => total + file.bytes, 0);
    let totalEntries = files.length;
    for (const file of files) {
      if (totalEntries <= this.maxEntries && totalBytes <= this.maxBytes) break;
      await unlink(file.path).catch(() => undefined);
      totalEntries -= 1;
      totalBytes -= file.bytes;
    }
  }
}
