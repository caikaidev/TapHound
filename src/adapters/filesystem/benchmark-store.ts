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
  BenchmarkCaseSchema,
  BenchmarkGroundTruthSchema,
  BenchmarkRunResultSchema,
  type BenchmarkGroundTruth,
  type BenchmarkRunResult
} from "../../domain/benchmark.js";
import { KnowledgeIdSchema } from "../../domain/knowledge.js";
import {
  BENCHMARKS_DIR,
  BENCHMARK_RUNS_DIR,
  GROUND_TRUTH_DIR
} from "../../domain/workspace.js";
import type {
  BenchmarkCaseRecord,
  BenchmarkStore
} from "../../ports/benchmark-store.js";
import { isErrnoException } from "../../shared/errors.js";
import { isContained } from "../../shared/paths.js";

const MAX_BENCHMARK_BYTES = 1024 * 1024;

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
      throw new Error(`Benchmark path is unsafe: ${current}`);
    }
  }
  const canonical = await realpath(current);
  if (!isContained(canonicalProject, canonical)) {
    throw new Error("Benchmark directory escapes the project");
  }
  return canonical;
}

async function readJson(path: string): Promise<unknown> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Benchmark document is not a regular file: ${path}`);
  }
  if (stats.size > MAX_BENCHMARK_BYTES) {
    throw new Error(`Benchmark document exceeds the size limit: ${path}`);
  }
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function readOptionalGroundTruth(
  projectRoot: string,
  id: string
): Promise<BenchmarkGroundTruth | undefined> {
  const root = await safeRoot(projectRoot, GROUND_TRUTH_DIR, false);
  if (root === undefined) return undefined;
  try {
    const groundTruth = BenchmarkGroundTruthSchema.parse(
      await readJson(join(root, `${id}.json`))
    );
    if (groundTruth.caseId !== id) {
      throw new Error(`Ground Truth case id does not match ${id}`);
    }
    return groundTruth;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export class FileSystemBenchmarkStore implements BenchmarkStore {
  public readonly readCases = async (
    projectRoot: string,
    caseIds?: readonly string[]
  ): Promise<readonly BenchmarkCaseRecord[]> => {
    const root = await safeRoot(projectRoot, BENCHMARKS_DIR, false);
    if (root === undefined) return [];
    const requested = caseIds === undefined
      ? undefined
      : new Set(caseIds.map((id) => KnowledgeIdSchema.parse(id)));
    const names = (await readdir(root))
      .filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(name))
      .sort((left, right) => left.localeCompare(right));
    const records: BenchmarkCaseRecord[] = [];
    for (const name of names) {
      const benchmark = BenchmarkCaseSchema.parse(
        await readJson(join(root, name))
      );
      if (`${benchmark.id}.json` !== name) {
        throw new Error(`Benchmark file name does not match case id: ${name}`);
      }
      if (requested !== undefined && !requested.has(benchmark.id)) continue;
      records.push({
        benchmark,
        groundTruth: await readOptionalGroundTruth(projectRoot, benchmark.id)
      });
    }
    if (
      requested !== undefined
      && records.length !== requested.size
    ) {
      const found = new Set(records.map((record) => record.benchmark.id));
      const missing = [...requested].filter((id) => !found.has(id));
      throw new Error(`Benchmark cases not found: ${missing.join(", ")}`);
    }
    return records;
  };

  public readonly writeResult = async (input: {
    projectRoot: string;
    result: BenchmarkRunResult;
  }): Promise<string> => {
    const result = BenchmarkRunResultSchema.parse(input.result);
    const root = await safeRoot(input.projectRoot, BENCHMARK_RUNS_DIR, true);
    if (root === undefined) throw new Error("Benchmark result root is unavailable");
    const target = join(root, `${result.runId}.json`);
    try {
      await lstat(target);
      throw new Error(`Benchmark run already exists: ${result.runId}`);
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
    return `${BENCHMARK_RUNS_DIR}/${result.runId}.json`;
  };
}
