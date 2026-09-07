import {
  BenchmarkCaseResultSchema,
  BenchmarkRunResultSchema,
  type BenchmarkCaseResult,
  type BenchmarkEngine,
  type BenchmarkRunResult
} from "../../domain/benchmark.js";
import type {
  BenchmarkCaseRecord,
  BenchmarkStore
} from "../../ports/benchmark-store.js";

export interface BenchmarkExecutor {
  execute: (input: {
    record: BenchmarkCaseRecord;
    engine: BenchmarkEngine;
  }) => Promise<BenchmarkCaseResult>;
}

function average(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;
}

export class BenchmarkRunner {
  public constructor(private readonly dependencies: {
    store: BenchmarkStore;
    executor: BenchmarkExecutor;
    now: () => Date;
    createRunId: () => string;
  }) {}

  public readonly run = async (input: {
    projectRoot: string;
    engine: BenchmarkEngine;
    caseIds?: readonly string[] | undefined;
    knowledgeHash?: string | undefined;
  }): Promise<{ result: BenchmarkRunResult; path: string }> => {
    const startedAt = this.dependencies.now();
    const records = await this.dependencies.store.readCases(
      input.projectRoot,
      input.caseIds
    );
    const results: BenchmarkCaseResult[] = [];
    for (const record of records) {
      try {
        results.push(BenchmarkCaseResultSchema.parse(
          await this.dependencies.executor.execute({
            record,
            engine: input.engine
          })
        ));
      } catch (error) {
        results.push(BenchmarkCaseResultSchema.parse({
          caseId: record.benchmark.id,
          status: "failed",
          engine: input.engine,
          routeCorrect: null,
          firstRunSuccess: false,
          recoveryCount: 0,
          llmCalls: 0,
          llmInputTokens: 0,
          llmOutputTokens: 0,
          timing: {
            recognitionMs: 0,
            planningMs: 0,
            actionResolutionMs: 0,
            executionMs: 0,
            totalMs: 0
          },
          failureCode: "BENCHMARK_EXECUTOR_FAILED",
          detail: error instanceof Error ? error.message : String(error)
        }));
      }
    }
    const eligible = results.filter(
      (result) => result.status !== "invalid" && result.status !== "notRun"
    );
    const routeMeasured = eligible.filter(
      (result) => result.routeCorrect !== null
    );
    const result = BenchmarkRunResultSchema.parse({
      version: 1,
      runId: this.dependencies.createRunId(),
      startedAt: startedAt.toISOString(),
      completedAt: this.dependencies.now().toISOString(),
      ...(input.knowledgeHash === undefined
        ? {}
        : { knowledgeHash: input.knowledgeHash }),
      results,
      metrics: {
        eligibleCases: eligible.length,
        passedCases: eligible.filter((entry) => entry.status === "passed").length,
        firstRunSuccessRate: eligible.length === 0
          ? null
          : eligible.filter((entry) => entry.firstRunSuccess === true).length
            / eligible.length,
        routeAccuracy: routeMeasured.length === 0
          ? null
          : routeMeasured.filter((entry) => entry.routeCorrect === true).length
            / routeMeasured.length,
        averageRecognitionMs: average(
          eligible.map((entry) => entry.timing.recognitionMs)
        ),
        averagePlanningMs: average(
          eligible.map((entry) => entry.timing.planningMs)
        ),
        averageRecoveryCount: average(
          eligible.map((entry) => entry.recoveryCount)
        ),
        totalLlmCalls: results.reduce(
          (total, entry) => total + entry.llmCalls,
          0
        ),
        totalLlmInputTokens: results.reduce(
          (total, entry) => total + entry.llmInputTokens,
          0
        ),
        totalLlmOutputTokens: results.reduce(
          (total, entry) => total + entry.llmOutputTokens,
          0
        )
      }
    });
    const path = await this.dependencies.store.writeResult({
      projectRoot: input.projectRoot,
      result
    });
    return { result, path };
  };
}
