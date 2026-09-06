import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";

import {
  KnowledgeIdSchema
} from "../../domain/knowledge.js";
import {
  KnowledgeReceiptSchema,
  type KnowledgeReceipt
} from "../../domain/knowledge-receipt.js";
import { KNOWLEDGE_RECEIPTS_DIR } from "../../domain/workspace.js";
import type {
  KnowledgeReceiptStore
} from "../../ports/knowledge-receipt-store.js";
import { isErrnoException } from "../../shared/errors.js";
import { isContained } from "../../shared/paths.js";

const MAX_RECEIPT_BYTES = 1024 * 1024;

async function receiptRoot(
  projectRoot: string,
  create: boolean
): Promise<string | undefined> {
  const canonicalProject = await realpath(projectRoot);
  let current = canonicalProject;
  for (const segment of KNOWLEDGE_RECEIPTS_DIR.split("/")) {
    current = join(current, segment);
    let stats: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
    }
    if (stats === undefined) {
      if (!create) return undefined;
      await mkdir(current);
    } else if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Knowledge receipt path is unsafe: ${current}`);
    }
  }
  const canonical = await realpath(current);
  if (!isContained(canonicalProject, canonical)) {
    throw new Error("Knowledge receipt directory escapes the project");
  }
  return canonical;
}

async function readReceipt(path: string): Promise<KnowledgeReceipt> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Knowledge receipt is not a regular file: ${path}`);
  }
  if (stats.size > MAX_RECEIPT_BYTES) {
    throw new Error(`Knowledge receipt exceeds the size limit: ${path}`);
  }
  return KnowledgeReceiptSchema.parse(
    JSON.parse(await readFile(path, "utf8")) as unknown
  );
}

export class FileSystemKnowledgeReceiptStore
implements KnowledgeReceiptStore {
  public readonly write = async (input: {
    projectRoot: string;
    receipt: KnowledgeReceipt;
  }): Promise<string> => {
    const receipt = KnowledgeReceiptSchema.parse(input.receipt);
    const root = await receiptRoot(input.projectRoot, true);
    if (root === undefined) throw new Error("Knowledge receipt root is unavailable");
    const target = join(root, `${receipt.id}.json`);
    try {
      await lstat(target);
      throw new Error(`Knowledge receipt already exists: ${receipt.id}`);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
    }
    const temporary = join(root, `.${receipt.id}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    try {
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return `${KNOWLEDGE_RECEIPTS_DIR}/${receipt.id}.json`;
  };

  public readonly read = async (input: {
    projectRoot: string;
    receiptId: string;
  }): Promise<KnowledgeReceipt> => {
    const id = KnowledgeIdSchema.parse(input.receiptId);
    const root = await receiptRoot(input.projectRoot, false);
    if (root === undefined) {
      throw new Error(`Knowledge receipt not found: ${id}`);
    }
    return readReceipt(join(root, `${id}.json`));
  };

  public readonly list = async (
    projectRoot: string
  ): Promise<readonly KnowledgeReceipt[]> => {
    const root = await receiptRoot(projectRoot, false);
    if (root === undefined) return [];
    const names = (await readdir(root))
      .filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(name))
      .sort((left, right) => left.localeCompare(right));
    return Promise.all(names.map((name) => readReceipt(join(root, name))));
  };
}
