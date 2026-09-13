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
  FalseDoneCaseSchema,
  FalseDoneRunResultSchema,
  type FalseDoneCase,
  type FalseDoneRunResult
} from "../../domain/false-done.js";
import { KnowledgeIdSchema } from "../../domain/knowledge.js";
import {
  FALSE_DONE_DIR,
  FALSE_DONE_RUNS_DIR
} from "../../domain/workspace.js";
import type { FalseDoneStore } from "../../ports/false-done-store.js";
import { isErrnoException } from "../../shared/errors.js";
import { isContained } from "../../shared/paths.js";

const MAX_FALSE_DONE_BYTES = 1024 * 1024;

async function safeRoot(
  projectRoot: string,
  relativePath: string,
  create: boolean
): Promise<string | undefined> {
  const canonicalProject = await realpath(projectRoot);
  let current = canonicalProject;
  for (const segment of relativePath.split("/")) {
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
      throw new Error(`False-Done path is unsafe: ${current}`);
    }
  }
  const canonical = await realpath(current);
  if (!isContained(canonicalProject, canonical)) {
    throw new Error("False-Done directory escapes the project");
  }
  return canonical;
}

async function readJson(path: string): Promise<unknown> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`False-Done document is not a regular file: ${path}`);
  }
  if (stats.size > MAX_FALSE_DONE_BYTES) {
    throw new Error(`False-Done document exceeds the size limit: ${path}`);
  }
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export class FileSystemFalseDoneStore implements FalseDoneStore {
  public readonly readCases = async (
    projectRoot: string,
    caseIds?: readonly string[]
  ): Promise<readonly FalseDoneCase[]> => {
    const root = await safeRoot(projectRoot, FALSE_DONE_DIR, false);
    if (root === undefined) return [];
    const requested = caseIds === undefined
      ? undefined
      : new Set(caseIds.map((id) => KnowledgeIdSchema.parse(id)));
    const names = (await readdir(root))
      .filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(name))
      .sort((left, right) => left.localeCompare(right));
    const cases: FalseDoneCase[] = [];
    for (const name of names) {
      const item = FalseDoneCaseSchema.parse(
        await readJson(join(root, name))
      );
      if (`${item.id}.json` !== name) {
        throw new Error(`False-Done file name does not match case id: ${name}`);
      }
      if (requested !== undefined && !requested.has(item.id)) continue;
      cases.push(item);
    }
    if (
      requested !== undefined
      && cases.length !== requested.size
    ) {
      const found = new Set(cases.map((item) => item.id));
      const missing = [...requested].filter((id) => !found.has(id));
      throw new Error(`False-Done cases not found: ${missing.join(", ")}`);
    }
    return cases;
  };

  public readonly writeResult = async (input: {
    projectRoot: string;
    result: FalseDoneRunResult;
  }): Promise<string> => {
    const result = FalseDoneRunResultSchema.parse(input.result);
    const root = await safeRoot(input.projectRoot, FALSE_DONE_RUNS_DIR, true);
    if (root === undefined) {
      throw new Error("False-Done result root is unavailable");
    }
    const target = join(root, `${result.runId}.json`);
    try {
      await lstat(target);
      throw new Error(`False-Done run already exists: ${result.runId}`);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
    }
    const temporary = join(root, `.${result.runId}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    try {
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return `${FALSE_DONE_RUNS_DIR}/${result.runId}.json`;
  };

  public readonly readResult = async (
    projectRoot: string,
    runId: string
  ): Promise<FalseDoneRunResult> => {
    const root = await safeRoot(projectRoot, FALSE_DONE_RUNS_DIR, false);
    if (root === undefined) {
      throw new Error("False-Done results are unavailable in this project");
    }
    const target = join(root, `${runId}.json`);
    const stats = await lstat(target);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`False-Done run is not a regular file: ${target}`);
    }
    if (stats.size > MAX_FALSE_DONE_BYTES) {
      throw new Error(`False-Done run exceeds the size limit: ${target}`);
    }
    const result = FalseDoneRunResultSchema.parse(
      JSON.parse(await readFile(target, "utf8")) as unknown
    );
    if (result.runId !== runId) {
      throw new Error(`False-Done run id does not match file name: ${runId}`);
    }
    return result;
  };
}