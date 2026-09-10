import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import {
  AnchorDefinitionSchema,
  KnowledgeBundleIndexSchema,
  ScreenDefinitionSchema,
  TransitionDefinitionSchema,
  hashKnowledge,
  type AnchorDefinition,
  type KnowledgeBundleIndex,
  type ScreenDefinition,
  type TransitionDefinition
} from "../../domain/knowledge.js";
import {
  KNOWLEDGE_DIR,
  KNOWLEDGE_INDEX_PATH,
  TAPHOUND_DIR,
  tapHoundPath
} from "../../domain/workspace.js";
import type {
  KnowledgeRegistryPort,
  LoadedKnowledgeBundle,
  WriteKnowledgeBundleInput,
  WriteKnowledgeBundleResult
} from "../../ports/knowledge-registry.js";
import { isErrnoException } from "../../shared/errors.js";
import { isContained } from "../../shared/paths.js";

const MAX_KNOWLEDGE_FILE_BYTES = 1024 * 1024;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5000;

type KnowledgeDocument =
  | AnchorDefinition
  | ScreenDefinition
  | TransitionDefinition;

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function serializedDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function optionalStats(path: string): Promise<
  Awaited<ReturnType<typeof lstat>> | undefined
> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function ensureSafeDirectory(
  projectRoot: string,
  relativePath: string
): Promise<string> {
  const canonicalProject = await realpath(projectRoot);
  let current = canonicalProject;
  for (const segment of relativePath.split("/")) {
    current = join(current, segment);
    const stats = await optionalStats(current);
    if (stats === undefined) {
      await mkdir(current);
    } else if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Knowledge path is not a safe directory: ${current}`);
    }
  }
  const canonical = await realpath(current);
  if (!isContained(canonicalProject, canonical)) {
    throw new Error("Knowledge directory escapes the project root");
  }
  return canonical;
}

async function readBoundedJson(path: string): Promise<{
  bytes: Buffer;
  value: unknown;
}> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Knowledge document is not a regular file: ${path}`);
  }
  if (before.size > MAX_KNOWLEDGE_FILE_BYTES) {
    throw new Error(`Knowledge document exceeds the size limit: ${path}`);
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || after.isSymbolicLink()
  ) {
    throw new Error(`Knowledge document changed while loading: ${path}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`Knowledge document is not valid JSON: ${path}`, {
      cause: error
    });
  }
  return { bytes, value };
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`
  );
  await writeFile(temporary, serializedDocument(value), {
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

function expectedPath(
  kind: "anchors" | "screens" | "transitions",
  id: string
): string {
  return `${KNOWLEDGE_DIR}/${kind}/${id}.json`;
}

function assertReferencePath(
  kind: "anchors" | "screens" | "transitions",
  id: string,
  path: string
): void {
  if (path !== expectedPath(kind, id)) {
    throw new Error(
      `Knowledge reference ${id} must use ${expectedPath(kind, id)}`
    );
  }
}

function assertUniqueDocuments(
  label: string,
  values: readonly KnowledgeDocument[]
): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) {
      throw new Error(`Duplicate ${label} id: ${value.id}`);
    }
    ids.add(value.id);
  }
}

function assertBundleReferences(input: {
  anchors: readonly AnchorDefinition[];
  screens: readonly ScreenDefinition[];
  transitions: readonly TransitionDefinition[];
}): void {
  const anchors = new Set(input.anchors.map((anchor) => anchor.id));
  const anchorsById = new Map(input.anchors.map((anchor) => [anchor.id, anchor]));
  const screens = new Set(input.screens.map((screen) => screen.id));
  for (const screen of input.screens) {
    const references = [
      ...screen.requiredAnchors,
      ...screen.optionalAnchors,
      ...screen.forbiddenAnchors,
      ...screen.predicates
        .filter((predicate) => predicate.kind !== "activityIs")
        .map((predicate) => predicate.anchorId)
    ];
    for (const anchorId of references) {
      if (!anchors.has(anchorId)) {
        throw new Error(`Screen ${screen.id} references unknown Anchor ${anchorId}`);
      }
    }
    for (const predicate of screen.predicates) {
      if (
        predicate.kind === "windowPresent"
        && anchorsById.get(predicate.anchorId)?.identity.kind !== "window"
      ) {
        throw new Error(
          `Screen ${screen.id} window predicate requires a window Anchor`
        );
      }
    }
  }
  for (const transition of input.transitions) {
    if (
      !screens.has(transition.fromScreen)
      || !screens.has(transition.toScreen)
    ) {
      throw new Error(`Transition ${transition.id} references an unknown Screen`);
    }
    const action = transition.action;
    for (const anchorId of [
      ...("anchorId" in action ? [action.anchorId] : []),
      ...("containerAnchorId" in action ? [action.containerAnchorId] : [])
    ]) {
      if (!anchors.has(anchorId)) {
        throw new Error(
          `Transition ${transition.id} references unknown Anchor ${anchorId}`
        );
      }
    }
  }
}

function bundleHash(indexSha256: string, index: KnowledgeBundleIndex): string {
  return hashKnowledge({
    indexSha256,
    anchors: index.anchors.map(({ id, sha256: hash }) => ({ id, sha256: hash })),
    screens: index.screens.map(({ id, sha256: hash }) => ({ id, sha256: hash })),
    transitions: index.transitions.map(
      ({ id, sha256: hash }) => ({ id, sha256: hash })
    )
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export class FileSystemKnowledgeRegistry implements KnowledgeRegistryPort {
  private queue: Promise<void> = Promise.resolve();

  public readonly load = async (
    projectRoot: string,
    workspaceRoot?: string  
  ): Promise<LoadedKnowledgeBundle> => {
    const canonicalProject = await realpath(projectRoot);
    const indexPath = resolve(
      tapHoundPath(canonicalProject, workspaceRoot, KNOWLEDGE_INDEX_PATH)
    );
    const base = workspaceRoot ?? canonicalProject;
    if (!isContained(base, indexPath)) {
      throw new Error("Knowledge index escapes the project root");
    }
    const loadedIndex = await readBoundedJson(indexPath);
    const index = KnowledgeBundleIndexSchema.parse(loadedIndex.value);
    const anchors = await this.readDocuments(
      canonicalProject,
      workspaceRoot,
      "anchors",
      index.anchors,
      AnchorDefinitionSchema
    );
    const screens = await this.readDocuments(
      canonicalProject,
      workspaceRoot,
      "screens",
      index.screens,
      ScreenDefinitionSchema
    );
    const transitions = await this.readDocuments(
      canonicalProject,
      workspaceRoot,
      "transitions",
      index.transitions,
      TransitionDefinitionSchema
    );
    assertBundleReferences({ anchors, screens, transitions });
    const indexSha256 = sha256(loadedIndex.bytes);
    return {
      index,
      indexSha256,
      knowledgeHash: bundleHash(indexSha256, index),
      anchors,
      screens,
      transitions
    };
  };

  public readonly writePromoted = (
    input: WriteKnowledgeBundleInput
  ): Promise<WriteKnowledgeBundleResult> => this.serialized(
    () => this.withLock(input.projectRoot, () => this.writeUnlocked(input))
  );

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async withLock<T>(
    projectRoot: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const workspaceRoot = await ensureSafeDirectory(
      projectRoot,
      TAPHOUND_DIR
    );
    const lockPath = join(workspaceRoot, ".knowledge-promotion.lock");
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    while (handle === undefined) {
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (
          !isErrnoException(error)
          || error.code !== "EEXIST"
          || Date.now() >= deadline
        ) {
          throw new Error("Knowledge promotion lock is unavailable", {
            cause: error
          });
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
    try {
      return await operation();
    } finally {
      await handle.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private async writeUnlocked(
    input: WriteKnowledgeBundleInput
  ): Promise<WriteKnowledgeBundleResult> {
    const anchors = input.anchors.map(
      (anchor) => AnchorDefinitionSchema.parse(anchor)
    );
    const screens = input.screens.map(
      (screen) => ScreenDefinitionSchema.parse(screen)
    );
    const transitions = input.transitions.map(
      (transition) => TransitionDefinitionSchema.parse(transition)
    );
    assertUniqueDocuments("Anchor", anchors);
    assertUniqueDocuments("Screen", screens);
    assertUniqueDocuments("Transition", transitions);
    assertBundleReferences({ anchors, screens, transitions });

    const existing = await this.load(input.projectRoot).catch(
      (error: unknown): LoadedKnowledgeBundle | undefined => {
        if (isErrnoException(error) && error.code === "ENOENT") return undefined;
        throw error;
      }
    );
    if (
      input.expectedKnowledgeHash !== undefined
      && existing?.knowledgeHash !== input.expectedKnowledgeHash
    ) {
      throw new Error("Knowledge promotion conflict: Registry hash changed");
    }
    if (
      existing !== undefined
      && existing.index.packageName !== input.packageName
    ) {
      throw new Error("Knowledge package identity cannot change");
    }

    const canonicalProject = await realpath(input.projectRoot);
    const workspaceRoot = await ensureSafeDirectory(
      input.projectRoot,
      TAPHOUND_DIR
    );
    const nonce = randomUUID();
    const stagingRoot = join(workspaceRoot, `.knowledge.${nonce}.staging`);
    const backupRoot = join(workspaceRoot, `.knowledge.${nonce}.backup`);
    const knowledgeRoot = resolve(canonicalProject, KNOWLEDGE_DIR);
    await mkdir(stagingRoot, { mode: 0o700 });
    let oldMoved = false;
    let installed = false;
    try {
      const roots = {
        anchors: join(stagingRoot, "anchors"),
        screens: join(stagingRoot, "screens"),
        transitions: join(stagingRoot, "transitions")
      };
      await Promise.all(Object.values(roots).map(
        (path) => mkdir(path, { mode: 0o700 })
      ));
      const writeDocuments = async (
        kind: keyof typeof roots,
        documents: readonly KnowledgeDocument[]
      ): Promise<KnowledgeBundleIndex[typeof kind]> => {
        const references = [];
        for (const document of [...documents].sort(
          (left, right) => left.id.localeCompare(right.id)
        )) {
          const path = join(roots[kind], `${document.id}.json`);
          await atomicWrite(path, document);
          references.push({
            id: document.id,
            path: expectedPath(kind, document.id),
            sha256: sha256(await readFile(path)),
            status: document.status
          });
        }
        return references;
      };
      const index = KnowledgeBundleIndexSchema.parse({
        version: 1,
        packageName: input.packageName,
        revision: (existing?.index.revision ?? 0) + 1,
        anchors: await writeDocuments("anchors", anchors),
        screens: await writeDocuments("screens", screens),
        transitions: await writeDocuments("transitions", transitions)
      });
      const stagedIndexPath = join(stagingRoot, "index.json");
      await atomicWrite(stagedIndexPath, index);
      const indexSha256 = sha256(await readFile(stagedIndexPath));

      const current = await optionalStats(knowledgeRoot);
      if (current !== undefined) {
        if (!current.isDirectory() || current.isSymbolicLink()) {
          throw new Error("Knowledge authority path is unsafe");
        }
        await rename(knowledgeRoot, backupRoot);
        oldMoved = true;
      }
      try {
        await rename(stagingRoot, knowledgeRoot);
        installed = true;
      } catch (error) {
        if (oldMoved) await rename(backupRoot, knowledgeRoot);
        throw error;
      }
      if (oldMoved) {
        await rm(backupRoot, { recursive: true, force: true })
          .catch(() => undefined);
      }
      return {
        indexPath: relative(
          canonicalProject,
          join(knowledgeRoot, "index.json")
        ).replaceAll("\\", "/"),
        knowledgeHash: bundleHash(indexSha256, index),
        revision: index.revision
      };
    } finally {
      if (!installed) {
        await rm(stagingRoot, { recursive: true, force: true })
          .catch(() => undefined);
      }
    }
  }

  private async readDocuments<T extends KnowledgeDocument>(
    canonicalProject: string,
    workspaceRoot: string | undefined,
    kind: "anchors" | "screens" | "transitions",
    references: KnowledgeBundleIndex[typeof kind],
    schema: { parse: (value: unknown) => T }
  ): Promise<T[]> {
    const documents: T[] = [];
    const base = workspaceRoot ?? canonicalProject;
    for (const reference of references) {
      assertReferencePath(kind, reference.id, reference.path);
      const path = resolve(
        tapHoundPath(canonicalProject, workspaceRoot, reference.path)
      );
      if (!isContained(base, path)) {
        throw new Error(`Knowledge reference escapes the project: ${reference.id}`);
      }
      const loaded = await readBoundedJson(path);
      if (sha256(loaded.bytes) !== reference.sha256) {
        throw new Error(`Knowledge document is stale: ${reference.path}`);
      }
      const document = schema.parse(loaded.value);
      if (
        document.id !== reference.id
        || document.status !== reference.status
      ) {
        throw new Error(`Knowledge reference identity mismatch: ${reference.path}`);
      }
      documents.push(document);
    }
    return documents;
  }
}
