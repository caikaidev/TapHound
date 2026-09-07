import { describe, expect, it, vi } from "vitest";

import {
  ReplayBenchmarkExecutor,
  readStoredJourney
} from "../../../src/application/benchmark/replay-benchmark-executor.js";
import type { BenchmarkCaseResult } from "../../../src/domain/benchmark.js";
import type { Journey } from "../../../src/domain/journey.js";
import type { JourneyResolver } from "../../../src/application/journey/journey-resolver.js";
import type { VerifyRuntime } from "../../../src/application/runtime/verify-runtime.js";
import type { BenchmarkCaseRecord } from "../../../src/ports/benchmark-store.js";

type ResolveFlow = Pick<JourneyResolver, "resolveFlow">["resolveFlow"];
type Verify = Pick<VerifyRuntime, "verify">["verify"];

const journey: Journey = {
  version: 2,
  name: "legacy-home-search",
  devices: [{ role: "default" }],
  steps: [{
    action: "wait",
    activity: {
      before: "com.example.app.MainActivity",
      after: "com.example.app.MainActivity"
    }
  }]
};

const environment = {
  projectRoot: "/project",
  config: {} as never,
  context: {} as never,
  project: {} as never,
  deviceSerial: "emulator-5554",
  toolVersions: {}
};

const record = (
  baseline: BenchmarkCaseRecord["benchmark"]["baseline"]
): BenchmarkCaseRecord => ({
  benchmark: {
    version: 1,
    id: "home-search",
    description: "Open search from Home",
    goal: {
      version: 1,
      id: "goal-home-search",
      targetScreen: "home-search",
      parameters: {},
      limits: { maxSteps: 3, maxReplans: 1 }
    },
    preconditions: [],
    tags: [],
    ...(baseline === undefined ? {} : { baseline })
  }
});

function executor(overrides: {
  verification?: {
    status: "passed" | "failed";
    exitCode: 0 | 1;
    primaryFailure?: { code: string; message: string };
  };
  resolveFlow?: ResolveFlow;
  readJourney?: () => Promise<Journey>;
}): ReplayBenchmarkExecutor {
  const verify: Verify = (): Promise<Awaited<ReturnType<Verify>>> => {
    const outcome = overrides.verification ?? {
      status: "passed" as const,
      exitCode: 0 as const
    };
    return Promise.resolve({
      status: outcome.status,
      exitCode: outcome.exitCode,
      report: {
        ...(outcome.primaryFailure === undefined
          ? {}
          : {
            primaryFailure: {
              code: outcome.primaryFailure.code,
              message: outcome.primaryFailure.message
            }
          })
      },
      reportPath: "report.json",
      summaryPath: "summary.json"
    } as unknown as Awaited<ReturnType<Verify>>);
  };
  return new ReplayBenchmarkExecutor({
    journeyResolver: {
      resolveFlow: overrides.resolveFlow ?? ((): Promise<
        Awaited<ReturnType<ResolveFlow>>
      > => Promise.reject(new Error("unused")))
    },
    verifier: { verify },
    readJourney: overrides.readJourney
      ?? ((): Promise<Journey> => Promise.resolve(journey)),
    now: (): Date => new Date("2026-09-06T00:00:00.000Z")
  });
}

function execute(
  replayExecutor: ReplayBenchmarkExecutor,
  engine: "baseFlow" | "legacy" | "knowledge",
  baseline: BenchmarkCaseRecord["benchmark"]["baseline"]
): Promise<BenchmarkCaseResult> {
  return replayExecutor.execute({
    record: record(baseline),
    engine,
    environment
  });
}

describe("ReplayBenchmarkExecutor", () => {
  it("passes when the recorded Journey replays cleanly", async () => {
    const replayExecutor = executor({});

    const result = await execute(replayExecutor, "legacy", {
      kind: "journey",
      name: "legacy-home-search"
    });

    expect(result).toMatchObject({
      status: "passed",
      engine: "legacy",
      routeCorrect: null,
      firstRunSuccess: true,
      recoveryCount: 0,
      llmCalls: 0
    });
  });

  it("reports the primary failure code when Replay fails", async () => {
    const replayExecutor = executor({
      verification: {
        status: "failed",
        exitCode: 1,
        primaryFailure: { code: "LOCATOR_NOT_FOUND", message: "gone" }
      }
    });

    const result = await execute(replayExecutor, "legacy", {
      kind: "journey",
      name: "legacy-home-search"
    });

    expect(result).toMatchObject({
      status: "failed",
      failureCode: "LOCATOR_NOT_FOUND",
      detail: "gone"
    });
  });

  it("replays the named baseFlow for the baseFlow engine", async () => {
    const resolveFlow = vi.fn<ResolveFlow>().mockResolvedValue({
      flow: { name: "home-search" },
      journey
    } as unknown as Awaited<ReturnType<ResolveFlow>>);
    const replayExecutor = executor({ resolveFlow });

    const result = await execute(replayExecutor, "baseFlow", {
      kind: "baseFlow",
      name: "home-search"
    });

    expect(resolveFlow).toHaveBeenCalledWith({
      projectRoot: "/project",
      name: "home-search"
    });
    expect(result.status).toBe("passed");
  });

  it("rejects a knowledge engine run and a missing baseline", async () => {
    const replayExecutor = executor({});

    const knowledgeResult = await execute(replayExecutor, "knowledge", {
      kind: "journey",
      name: "legacy-home-search"
    });
    const missingResult = await execute(replayExecutor, "legacy", undefined);

    expect(knowledgeResult).toMatchObject({
      status: "invalid",
      failureCode: "BENCHMARK_ENGINE_MISMATCH"
    });
    expect(missingResult).toMatchObject({
      status: "invalid",
      failureCode: "BENCHMARK_BASELINE_MISSING"
    });
  });

  it("reads stored Journeys from the conventional directory", async () => {
    const readJson = vi
      .fn()
      .mockResolvedValue(JSON.parse(JSON.stringify(journey)));
    const read = readStoredJourney(readJson);

    const stored = await read("/project", "legacy-home-search");

    expect(readJson).toHaveBeenCalledWith(
      "/project/.taphound/journeys/legacy-home-search.json"
    );
    expect(stored.name).toBe("legacy-home-search");
  });
});
