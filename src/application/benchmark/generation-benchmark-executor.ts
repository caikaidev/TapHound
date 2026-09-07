import type { BenchmarkCaseResult } from "../../domain/benchmark.js";
import type {
  BenchmarkEngine,
  BenchmarkGroundTruth
} from "../../domain/benchmark.js";
import type { GenerationSession } from "../../domain/generation.js";
import type { RuntimeSnapshot } from "../../domain/runtime-snapshot.js";
import type {
  ActionResolutionResult
} from "../../application/resolution/action-resolver.js";
import {
  GenerationOperationError
} from "../generation/generation-starter.js";
import type {
  GenerationStepExecutor
} from "../generation/generation-step-executor.js";
import type { RuntimeObserver } from "../generation/runtime-observer.js";
import type { GenerationStarter } from "../generation/generation-starter.js";
import type {
  GenerationConfirmationService
} from "../generation/generation-confirmation-service.js";
import type { BenchmarkCaseRecord } from "../../ports/benchmark-store.js";
import type {
  BenchmarkExecutorEnvironment,
  EngineAwareBenchmarkExecutor
} from "./benchmark-executor.js";

export interface GenerationBenchmarkRuntime {
  starter: Pick<GenerationStarter, "start">;
  observer: Pick<RuntimeObserver, "observe">;
  executor: Pick<GenerationStepExecutor, "execute">;
  confirmation: Pick<GenerationConfirmationService, "request">;
  readSession: (generationId: string) => Promise<GenerationSession>;
  resolvePlannedAction: (input: {
    session: GenerationSession;
    snapshot: RuntimeSnapshot;
  }) => Promise<ActionResolutionResult>;
}

interface BenchmarkTiming {
  recognitionMs: number;
  planningMs: number;
  actionResolutionMs: number;
  executionMs: number;
}

function goalReached(session: GenerationSession): boolean {
  return session.version === 2
    && session.planning !== undefined
    && session.planning.currentRoute !== null
    && session.planning.currentRoute.segments.length === 0;
}

function routeTransitionIds(
  session: GenerationSession
): readonly string[] | null {
  const segments = session.version === 2
    ? session.planning?.currentRoute?.segments
    : undefined;
  return segments === undefined ? null : segments.map(
    (segment) => segment.transitionId
  );
}

function routeMatches(
  actual: readonly string[] | null,
  groundTruth: BenchmarkGroundTruth
): boolean | null {
  if (groundTruth.expectedOutcome === "noRoute") {
    return actual === null || actual.length === 0;
  }
  if (actual === null) return false;
  const expected = groundTruth.routeTransitionIds;
  if (actual.length === 0) return expected.length === 0;
  if (actual.length > expected.length) return false;
  // Cold-start auto-advance can move the app downstream of the Ground Truth
  // start Screen before the first stable observation. The planner then
  // correctly plans only the remaining suffix, so a planned route matches
  // when it equals the tail of the Ground Truth route.
  const offset = expected.length - actual.length;
  return actual.every(
    (transitionId, index) => transitionId === expected[offset + index]
  );
}

function snapshotStaleMessage(error: unknown): string | undefined {
  if (
    error instanceof GenerationOperationError
    && error.code === "SNAPSHOT_STALE"
  ) {
    return error.message;
  }
  return undefined;
}

export class GenerationBenchmarkExecutor implements EngineAwareBenchmarkExecutor {
  public constructor(private readonly dependencies: {
    runtime: GenerationBenchmarkRuntime;
    now: () => Date;
  }) {}

  public readonly execute = async (input: {
    record: BenchmarkCaseRecord;
    engine: BenchmarkEngine;
    environment: BenchmarkExecutorEnvironment;
  }): Promise<BenchmarkCaseResult> => {
    const { benchmark, groundTruth } = input.record;
    const timing: BenchmarkTiming = {
      recognitionMs: 0,
      planningMs: 0,
      actionResolutionMs: 0,
      executionMs: 0
    };
    const startedAt = this.dependencies.now();
    const failure = (
      code: string,
      detail: string
    ): BenchmarkCaseResult => ({
      caseId: benchmark.id,
      status: "failed",
      engine: input.engine,
      routeCorrect: groundTruth === undefined
        ? null
        : routeMatches(null, groundTruth),
      firstRunSuccess: false,
      recoveryCount: 0,
      llmCalls: 0,
      llmInputTokens: 0,
      llmOutputTokens: 0,
      timing: {
        ...timing,
        totalMs: this.dependencies.now().getTime() - startedAt.getTime()
      },
      failureCode: code,
      detail
    });

    let session: GenerationSession;
    if (input.environment.knowledgeHash === undefined) {
      return failure(
        "KNOWLEDGE_INVALID",
        "Knowledge benchmark execution requires the current Knowledge hash"
      );
    }
    try {
      session = await this.dependencies.runtime.starter.start({
        projectRoot: input.environment.projectRoot,
        config: input.environment.config,
        context: input.environment.context,
        project: input.environment.project,
        deviceSerial: input.environment.deviceSerial,
        planning: {
          knowledgeHash: input.environment.knowledgeHash,
          goal: benchmark.goal
        },
        ...(input.environment.signal === undefined
          ? {}
          : { signal: input.environment.signal })
      });
    } catch (error) {
      if (error instanceof GenerationOperationError) {
        return failure(error.code, error.message);
      }
      throw error;
    }
    const generationId = session.id;

    let observation: Awaited<
      ReturnType<RuntimeObserver["observe"]>
    > | undefined;
    try {
      observation = await this.dependencies.runtime.observer.observe({
        generationId,
        ...(input.environment.signal === undefined
          ? {}
          : { signal: input.environment.signal })
      });
    } catch (error) {
      return this.planFailure(error, benchmark.id, input.engine, timing, startedAt, groundTruth);
    }
    if (observation.planningTiming !== undefined) {
      timing.recognitionMs += observation.planningTiming.recognitionMs;
      timing.planningMs += observation.planningTiming.planningMs;
    }
    session = await this.dependencies.runtime.readSession(generationId);
    const firstRoute = routeTransitionIds(session);
    if (goalReached(session)) {
      return this.passed(
        benchmark.id,
        input.engine,
        session,
        firstRoute,
        groundTruth,
        timing,
        startedAt
      );
    }

    const maxSteps = session.planning?.maxSteps ?? benchmark.goal.limits.maxSteps;
    let staleDetail: string | undefined;
    for (let step = 0; step < maxSteps; step++) {
      if (observation === undefined) {
        try {
          observation = await this.dependencies.runtime.observer.observe({
            generationId,
            ...(input.environment.signal === undefined
              ? {}
              : { signal: input.environment.signal })
          });
        } catch (error) {
          const stale = snapshotStaleMessage(error);
          if (stale !== undefined) {
            staleDetail = stale;
            continue;
          }
          return this.planFailure(
            error,
            benchmark.id,
            input.engine,
            timing,
            startedAt,
            groundTruth
          );
        }
        if (observation.planningTiming !== undefined) {
          timing.recognitionMs += observation.planningTiming.recognitionMs;
          timing.planningMs += observation.planningTiming.planningMs;
        }
        session = await this.dependencies.runtime.readSession(generationId);
        if (goalReached(session)) {
          return this.passed(
            benchmark.id,
            input.engine,
            session,
            firstRoute,
            groundTruth,
            timing,
            startedAt
          );
        }
      }

      const resolutionStartedAt = this.dependencies.now().getTime();
      let resolution: ActionResolutionResult;
      try {
        resolution = await this.dependencies.runtime.resolvePlannedAction({
          session,
          snapshot: observation.snapshot
        });
      } catch (error) {
        timing.actionResolutionMs += (
          this.dependencies.now().getTime() - resolutionStartedAt
        );
        const stale = snapshotStaleMessage(error);
        if (stale !== undefined) {
          staleDetail = stale;
          observation = undefined;
          continue;
        }
        throw error;
      }
      timing.actionResolutionMs += (
        this.dependencies.now().getTime() - resolutionStartedAt
      );
      if (resolution.status === "failed") {
        return failure(resolution.failure.code, resolution.failure.message);
      }

      let confirmation: Awaited<
        ReturnType<GenerationBenchmarkRuntime["confirmation"]["request"]>
      >;
      try {
        confirmation = await this.dependencies.runtime.confirmation.request({
          generationId,
          proposal: resolution.action.proposal,
          snapshot: observation.snapshot,
          source: "planner"
        });
      } catch (error) {
        const stale = snapshotStaleMessage(error);
        if (stale !== undefined) {
          staleDetail = stale;
          observation = undefined;
          continue;
        }
        throw error;
      }
      if (confirmation.status === "confirmationRequired") {
        return failure(
          "RISK_CONFIRMATION_REQUIRED",
          `Benchmark runs are unattended; confirmation challenge ${confirmation.challenge.challengeId} requires no human approval`
        );
      }

      let result: Awaited<
        ReturnType<GenerationBenchmarkRuntime["executor"]["execute"]>
      >;
      try {
        result = await this.dependencies.runtime.executor.execute({
          generationId,
          proposal: confirmation.proposal,
          snapshot: confirmation.snapshot,
          source: "planner",
          ...(input.environment.signal === undefined
            ? {}
            : { signal: input.environment.signal })
        });
      } catch (error) {
        const stale = snapshotStaleMessage(error);
        if (stale !== undefined) {
          staleDetail = stale;
          observation = undefined;
          continue;
        }
        throw error;
      }
      if (result.status !== "succeeded") {
        if (result.failure.code === "SNAPSHOT_STALE") {
          staleDetail = result.failure.message;
          observation = undefined;
          continue;
        }
        return failure(result.failure.code, result.failure.message);
      }
      timing.executionMs += result.timing?.totalMs ?? 0;

      if (result.nextObservation !== undefined) {
        observation = result.nextObservation;
        if (observation.planningTiming !== undefined) {
          timing.recognitionMs += observation.planningTiming.recognitionMs;
          timing.planningMs += observation.planningTiming.planningMs;
        }
      } else {
        observation = undefined;
      }
      session = await this.dependencies.runtime.readSession(generationId);
      if (goalReached(session)) {
        return this.passed(
          benchmark.id,
          input.engine,
          session,
          firstRoute,
          groundTruth,
          timing,
          startedAt
        );
      }
    }
    if (staleDetail !== undefined) {
      return failure("SNAPSHOT_STALE", staleDetail);
    }
    return failure(
      "BENCHMARK_STEP_BUDGET_EXHAUSTED",
      `The Goal was not reached within ${String(maxSteps)} steps`
    );
  };

  private passed(
    caseId: string,
    engine: BenchmarkEngine,
    session: GenerationSession,
    firstRoute: readonly string[] | null,
    groundTruth: BenchmarkGroundTruth | undefined,
    timing: BenchmarkTiming,
    startedAt: Date
  ): BenchmarkCaseResult {
    const recoveryCount = session.version === 2
      ? session.planning?.replansUsed ?? 0
      : 0;
    return {
      caseId,
      status: "passed",
      engine,
      routeCorrect: groundTruth === undefined
        ? null
        : routeMatches(firstRoute, groundTruth),
      firstRunSuccess: recoveryCount === 0,
      recoveryCount,
      llmCalls: 0,
      llmInputTokens: 0,
      llmOutputTokens: 0,
      timing: {
        ...timing,
        totalMs: this.dependencies.now().getTime() - startedAt.getTime()
      }
    };
  }

  private planFailure(
    error: unknown,
    caseId: string,
    engine: BenchmarkEngine,
    timing: BenchmarkTiming,
    startedAt: Date,
    groundTruth: BenchmarkGroundTruth | undefined
  ): BenchmarkCaseResult {
    if (!(error instanceof GenerationOperationError)) throw error;
    const noRouteExpected = groundTruth?.expectedOutcome === "noRoute";
    const passed = noRouteExpected && error.code === "NO_ROUTE";
    return {
      caseId,
      status: passed ? "passed" : "failed",
      engine,
      routeCorrect: groundTruth === undefined
        ? null
        : routeMatches(null, groundTruth),
      firstRunSuccess: passed,
      recoveryCount: 0,
      llmCalls: 0,
      llmInputTokens: 0,
      llmOutputTokens: 0,
      timing: {
        ...timing,
        totalMs: this.dependencies.now().getTime() - startedAt.getTime()
      },
      failureCode: error.code,
      detail: error.message
    };
  }
}
