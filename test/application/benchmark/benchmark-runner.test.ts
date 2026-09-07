import { describe, expect, it, vi } from "vitest";

import { BenchmarkRunner } from "../../../src/application/benchmark/benchmark-runner.js";
import type {
  BenchmarkCaseResult,
  BenchmarkEngine
} from "../../../src/domain/benchmark.js";
import type {
  BenchmarkCaseRecord,
  BenchmarkStore
} from "../../../src/ports/benchmark-store.js";

const benchmarkCase = (id: string): BenchmarkCaseRecord["benchmark"] => ({
  version: 1,
  id,
  description: id,
  goal: {
    version: 1,
    id: `goal-${id}`,
    targetScreen: "target",
    parameters: {},
    limits: { maxSteps: 3, maxReplans: 1 }
  },
  preconditions: [],
  tags: []
});

describe("BenchmarkRunner", () => {
  it("excludes invalid preconditions from engine success metrics", async () => {
    const records = ["valid", "invalid"].map((id) => ({
      benchmark: {
        version: 1 as const,
        id,
        description: id,
        goal: {
          version: 1 as const,
          id: `goal-${id}`,
          targetScreen: "target",
          parameters: {},
          limits: { maxSteps: 3, maxReplans: 1 }
        },
        preconditions: [],
        tags: []
      }
    }));
    const writeResult = vi.fn(() => Promise.resolve(
      ".taphound/build/benchmark-runs/run-1.json"
    ));
    const store: BenchmarkStore = {
      readCases: (): Promise<typeof records> => Promise.resolve(records),
      writeResult,
      readResult: (): Promise<never> => Promise.reject(new Error("unused"))
    };
    const runner = new BenchmarkRunner({
      store,
      executor: {
        execute: ({ record }): Promise<BenchmarkCaseResult> => Promise.resolve({
          caseId: record.benchmark.id,
          status: record.benchmark.id === "invalid" ? "invalid" : "passed",
          engine: "knowledge",
          routeCorrect: record.benchmark.id === "invalid" ? null : true,
          firstRunSuccess: record.benchmark.id === "invalid" ? null : true,
          recoveryCount: 0,
          llmCalls: 0,
          llmInputTokens: 0,
          llmOutputTokens: 0,
          timing: {
            recognitionMs: 2,
            planningMs: 3,
            actionResolutionMs: 1,
            executionMs: 4,
            totalMs: 10
          }
        })
      },
      now: (): Date => new Date("2026-09-06T00:00:00.000Z"),
      createRunId: (): string => "run-1"
    });

    const { result } = await runner.run({
      projectRoot: "/project",
      engine: "knowledge"
    });

    expect(result.metrics).toMatchObject({
      eligibleCases: 1,
      passedCases: 1,
      firstRunSuccessRate: 1,
      routeAccuracy: 1,
      totalLlmCalls: 0
    });
    expect(writeResult).toHaveBeenCalledOnce();
  });

  it.each(["legacy", "baseFlow", "knowledge"] as const)(
    "passes the %s engine through to the executor",
    async (engine: BenchmarkEngine) => {
      const execute = vi.fn((_input: {
        record: BenchmarkCaseRecord;
        engine: BenchmarkEngine;
      }): Promise<BenchmarkCaseResult> => Promise.resolve({
        caseId: _input.record.benchmark.id,
        status: "passed",
        engine: _input.engine,
        routeCorrect: null,
        firstRunSuccess: true,
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
        }
      }));
      const records: BenchmarkCaseRecord[] = [{
        benchmark: benchmarkCase("case-1"),
        groundTruth: undefined
      }];
      const store: BenchmarkStore = {
        readCases: (): Promise<readonly BenchmarkCaseRecord[]> =>
          Promise.resolve(records),
        writeResult: (): Promise<string> =>
          Promise.resolve(".taphound/build/benchmark-runs/run-1.json"),
        readResult: (): Promise<never> => Promise.reject(new Error("unused"))
      };
      const runner = new BenchmarkRunner({
        store,
        executor: { execute },
        now: (): Date => new Date("2026-09-06T00:00:00.000Z"),
        createRunId: (): string => "run-1"
      });

      const { result } = await runner.run({
        projectRoot: "/project",
        engine
      });

      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]?.[0].engine).toBe(engine);
      expect(result.results[0]).toMatchObject({ engine });
    }
  );
});
