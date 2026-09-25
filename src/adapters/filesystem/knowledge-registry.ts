import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import {
  AnchorDefinitionSchema,
  KnowledgeBundleIndexSchema,
  ScreenDefinitionSchema,
  hashKnowledge,
  type AnchorDefinition,
  type KnowledgeBundleIndex,
  type ScreenDefinition
} from "../../domain/knowledge.js";
import {
  KNOWLEDGE_DIR,
  KNOWLEDGE_INDEX_PATH
} from "../../domain/workspace.js";
import type {
  KnowledgeRegistryPort,
  KnowledgeRehashResult,
  LoadedKnowledgeBundle
} from "../../ports/knowledge-registry.js";
import { isErrnoException } from "../../shared/errors.js";
import { isContained } from "../../shared/paths.js";

const MAX_KNOWLEDGE_FILE_BYTES = 1024 * 1024;

type KnowledgeKind = "anchors" | "screens";
type KnowledgeDocument = AnchorDefinition | ScreenDefinition;

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function serializedDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
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
    mode: 0o644,
    flag: "wx"
  });
  try {
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function expectedPath(kind: KnowledgeKind, id: string): string {
  return `${KNOWLEDGE_DIR}/${kind}/${id}.json`;
}

function assertReferencePath(
  kind: KnowledgeKind,
  id: string,
  path: string
): void {
  if (path !== expectedPath(kind, id)) {
    throw new Error(
      `Knowledge reference ${id} must use ${expectedPath(kind, id)}`
    );
  }
}

function assertBundleReferences(input: {
  anchors: readonly AnchorDefinition[];
  screens: readonly ScreenDefinition[];
}): void {
  const anchorsById = new Map(input.anchors.map((anchor) => [anchor.id, anchor]));
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
      if (!anchorsById.has(anchorId)) {
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
}

function bundleHash(indexSha256: string, index: KnowledgeBundleIndex): string {
  return hashKnowledge({
    indexSha256,
    anchors: index.anchors.map(({ id, sha256: hash }) => ({ id, sha256: hash })),
    screens: index.screens.map(({ id, sha256: hash }) => ({ id, sha256: hash }))
  });
}

function sameReferences(
  left: KnowledgeBundleIndex[KnowledgeKind],
  right: KnowledgeBundleIndex[KnowledgeKind]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Knowledge is a committed, hand- or agent-authored library of semantic
 * Anchors and Screens. `index.json` binds every document by content hash;
 * `rehash` is the only writer and rebuilds the index from the documents.
 */
export class FileSystemKnowledgeRegistry implements KnowledgeRegistryPort {
  public readonly load = async (
    projectRoot: string
  ): Promise<LoadedKnowledgeBundle> => {
    const canonicalProject = await realpath(projectRoot);
    const indexPath = resolve(canonicalProject, KNOWLEDGE_INDEX_PATH);
    if (!isContained(canonicalProject, indexPath)) {
      throw new Error("Knowledge index escapes the project root");
    }
    const loadedIndex = await readBoundedJson(indexPath);
    const index = KnowledgeBundleIndexSchema.parse(loadedIndex.value);
    const anchors = await this.readDocuments(
      canonicalProject,
      "anchors",
      index.anchors,
      AnchorDefinitionSchema
    );
    const screens = await this.readDocuments(
      canonicalProject,
      "screens",
      index.screens,
      ScreenDefinitionSchema
    );
    assertBundleReferences({ anchors, screens });
    const indexSha256 = sha256(loadedIndex.bytes);
    return {
      index,
      indexSha256,
      knowledgeHash: bundleHash(indexSha256, index),
      anchors,
      screens
    };
  };

  public readonly rehash = async (
    projectRoot: string,
    packageName: string
  ): Promise<KnowledgeRehashResult> => {
    const canonicalProject = await realpath(projectRoot);
    const indexPath = resolve(canonicalProject, KNOWLEDGE_INDEX_PATH);
    let existing: KnowledgeBundleIndex | undefined;
    try {
      existing = KnowledgeBundleIndexSchema.parse(
        (await readBoundedJson(indexPath)).value
      );
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
    }
    if (existing !== undefined && existing.packageName !== packageName) {
      throw new Error(
        `Knowledge package ${existing.packageName} does not match configured package ${packageName}`
      );
    }
    const anchors = await this.scanDocuments(
      canonicalProject,
      "anchors",
      AnchorDefinitionSchema
    );
    const screens = await this.scanDocuments(
      canonicalProject,
      "screens",
      ScreenDefinitionSchema
    );
    assertBundleReferences({
      anchors: anchors.map(({ document }) => document),
      screens: screens.map(({ document }) => document)
    });
    const references = {
      anchors: anchors.map(({ reference }) => reference),
      screens: screens.map(({ reference }) => reference)
    };
    const changed = existing === undefined
      || !sameReferences(existing.anchors, references.anchors)
      || !sameReferences(existing.screens, references.screens);
    const index = KnowledgeBundleIndexSchema.parse({
      version: 1,
      packageName,
      revision: existing === undefined
        ? 1
        : existing.revision + (changed ? 1 : 0),
      ...references
    });
    if (changed) {
      await atomicWrite(indexPath, index);
    }
    const indexSha256 = sha256(await readFile(indexPath));
    return {
      indexPath: relative(canonicalProject, indexPath).replaceAll("\\", "/"),
      knowledgeHash: bundleHash(indexSha256, index),
      revision: index.revision,
      changed,
      anchors: index.anchors.length,
      screens: index.screens.length
    };
  };

  private async scanDocuments<T extends KnowledgeDocument>(
    canonicalProject: string,
    kind: KnowledgeKind,
    schema: { parse: (value: unknown) => T }
  ): Promise<{
    document: T;
    reference: KnowledgeBundleIndex[KnowledgeKind][number];
  }[]> {
    const directory = resolve(canonicalProject, KNOWLEDGE_DIR, kind);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return [];
      throw error;
    }
    const scanned = [];
    for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
      const loaded = await readBoundedJson(join(directory, name));
      const document = schema.parse(loaded.value);
      if (`${document.id}.json` !== name) {
        throw new Error(
          `Knowledge document ${KNOWLEDGE_DIR}/${kind}/${name} must be named ${document.id}.json`
        );
      }
      scanned.push({
        document,
        reference: {
          id: document.id,
          path: expectedPath(kind, document.id),
          sha256: sha256(loaded.bytes),
          status: document.status
        }
      });
    }
    return scanned;
  }

  private async readDocuments<T extends KnowledgeDocument>(
    canonicalProject: string,
    kind: KnowledgeKind,
    references: KnowledgeBundleIndex[KnowledgeKind],
    schema: { parse: (value: unknown) => T }
  ): Promise<T[]> {
    const documents: T[] = [];
    for (const reference of references) {
      assertReferencePath(kind, reference.id, reference.path);
      const path = resolve(canonicalProject, reference.path);
      if (!isContained(canonicalProject, path)) {
        throw new Error(`Knowledge reference escapes the project: ${reference.id}`);
      }
      const loaded = await readBoundedJson(path);
      if (sha256(loaded.bytes) !== reference.sha256) {
        throw new Error(
          `Knowledge document is stale: ${reference.path} (run taphound knowledge rehash)`
        );
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
