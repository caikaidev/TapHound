import type { TapHoundConfig } from "../../domain/config.js";
import type { BenchmarkCaseResult, BenchmarkEngine } from "../../domain/benchmark.js";
import type { ProjectDescription } from "../project/project-describer.js";
import type { ResolvedProjectContext } from "../../domain/project-context.js";
import type { BenchmarkCaseRecord } from "../../ports/benchmark-store.js";

export interface BenchmarkExecutorEnvironment {
  projectRoot: string;
  config: TapHoundConfig;
  context: ResolvedProjectContext;
  project: ProjectDescription;
  deviceSerial: string;
  toolVersions: Record<string, string>;
  knowledgeHash?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface EngineAwareBenchmarkExecutor {
  execute: (input: {
    record: BenchmarkCaseRecord;
    engine: BenchmarkEngine;
    environment: BenchmarkExecutorEnvironment;
  }) => Promise<BenchmarkCaseResult>;
}
