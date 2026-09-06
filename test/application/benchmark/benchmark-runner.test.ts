import { describe, expect, it, vi } from "vitest";

import { BenchmarkRunner } from "../../../src/application/benchmark/benchmark-runner.js";
import type { BenchmarkCaseResult } from "../../../src/domain/benchmark.js";
import type { BenchmarkStore } from "../../../src/ports/benchmark-store.js";

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
      writeResult
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
});
