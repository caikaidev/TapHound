import type {
  BenchmarkCase,
  BenchmarkGroundTruth,
  BenchmarkRunResult
} from "../domain/benchmark.js";

export interface BenchmarkCaseRecord {
  benchmark: BenchmarkCase;
  groundTruth?: BenchmarkGroundTruth | undefined;
}

export interface BenchmarkStore {
  readCases: (
    projectRoot: string,
    caseIds?: readonly string[]
  ) => Promise<readonly BenchmarkCaseRecord[]>;
  writeResult: (input: {
    projectRoot: string;
    result: BenchmarkRunResult;
  }) => Promise<string>;
  readResult: (projectRoot: string, runId: string) => Promise<BenchmarkRunResult>;
}
