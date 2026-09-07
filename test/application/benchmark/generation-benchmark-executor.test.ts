import { describe, expect, it, vi } from "vitest";

import {
  GenerationBenchmarkExecutor,
  type GenerationBenchmarkRuntime
} from "../../../src/application/benchmark/generation-benchmark-executor.js";
import { GenerationOperationError } from "../../../src/application/generation/generation-starter.js";
import type {
  ActionResolutionResult
} from "../../../src/application/resolution/action-resolver.js";
import type {
  BenchmarkCaseResult,
  BenchmarkEngine
} from "../../../src/domain/benchmark.js";
import type { GenerationSession } from "../../../src/domain/generation.js";
import type { RuntimeSnapshot } from "../../../src/domain/runtime-snapshot.js";
import { hashGoalSpec } from "../../../src/domain/route.js";
import type { BenchmarkCaseRecord } from "../../../src/ports/benchmark-store.js";

const knowledgeHash = "a".repeat(64);

const benchmarkCase = (
  routeTransitionIds: readonly string[],
  expectedOutcome: "success" | "noRoute" = "success"
): BenchmarkCaseRecord => ({
  benchmark: {
    version: 1,
    id: "open-detail",
    description: "Open the detail Screen",
    goal: {
      version: 1,
      id: "goal-open-detail",
      targetScreen: "detail",
      parameters: {},
      limits: { maxSteps: 3, maxReplans: 1 }
    },
    preconditions: [],
    tags: []
  },
  groundTruth: {
    version: 1,
    caseId: "open-detail",
    startScreen: "home",
    targetScreen: "detail",
    routeTransitionIds: [...routeTransitionIds],
    expectedOutcome
  }
});

const environment = {
  projectRoot: "/project",
  config: {} as never,
  context: {} as never,
  project: {} as never,
  deviceSerial: "emulator-5554",
  toolVersions: {},
  knowledgeHash
};

function session(routes: readonly string[][]): GenerationSession {
  const goal = {
    version: 1 as const,
    id: "goal-open-detail",
    targetScreen: "detail",
    parameters: {},
    limits: { maxSteps: 3, maxReplans: 1 }
  };
  const [current] = routes;
  const segments = (current ?? []).map((transitionId, index) => ({
    index,
    transitionId,
    fromScreen: "home",
    toScreen: "detail",
    cost: 1
  }));
  return {
    version: 2,
    id: "generation-1",
    revision: 1,
    state: "active",
    bindings: {
      projectHash: "1".repeat(64),
      configHash: "2".repeat(64),
      contextHash: "3".repeat(64),
      snapshotHash: "4".repeat(64)
    },
    target: {
      packageName: "com.example.app",
      deviceSerial: "emulator-5554",
      resetStrategy: "processOnly",
      interactionPolicy: {
        allowedActions: ["wait"],
        confirmationRequiredActions: [],
        forbiddenActions: []
      }
    },
    contextSelection: {
      bundleVersion: 2,
      indexHash: "5".repeat(64),
      modules: [{
        id: ":app",
        sha256: "6".repeat(64),
        projectDir: "app",
        inventory: { pathSetSha256: "7".repeat(64), categories: ["sources"] }
      }]
    },
    variables: {
      runId: "run-1",
      timestamp: "2026-09-06T00:00:00.000Z",
      randomHex: "00"
    },
    externalFlows: [],
    candidateSteps: [],
    candidateSources: [],
    inFlight: null,
    pendingConfirmation: null,
    verification: { status: "notRun" },
    publication: { status: "notRun" },
    planning: {
      knowledgeHash,
      goalHash: hashGoalSpec(goal),
      goal,
      currentScreen: current === undefined ? null : "home",
      currentRoute: {
        version: 1 as const,
        goalId: goal.id,
        knowledgeHash,
        startScreen: "home",
        targetScreen: "detail",
        segments,
        totalCost: segments.length,
        plannedAt: "2026-09-06T00:00:00.000Z"
      },
      replansUsed: 0,
      maxReplans: 1,
      maxSteps: 3
    }
  };
}

function snapshot(): RuntimeSnapshot {
  return {
    version: 1,
    generationId: "generation-1",
    baseRevision: 1,
    deviceSerial: "emulator-5554",
    expectedPackageName: "com.example.app",
    foregroundPackageName: "com.example.app",
    activity: "com.example.app.MainActivity",
    pid: 42,
    capturedAt: "2026-09-06T00:00:00.000Z",
    layout: []
  };
}

const proposal = {
  action: "wait" as const,
  binding: {
    generationId: "generation-1",
    baseRevision: 1,
    snapshotHash: "4".repeat(64)
  },
  activity: { before: "com.example.app.MainActivity" }
};

const observation = {
  binding: {
    generationId: "generation-1",
    baseRevision: 1,
    snapshotHash: "4".repeat(64)
  },
  snapshot: snapshot(),
  snapshotHash: "4".repeat(64),
  snapshotRef: "evidence/snapshot.json"
};

function runtime(overrides: {
  observe?: GenerationBenchmarkRuntime["observer"]["observe"];
  resolvePlannedAction?: GenerationBenchmarkRuntime["resolvePlannedAction"];
  confirmation?: GenerationBenchmarkRuntime["confirmation"]["request"];
  execute?: GenerationBenchmarkRuntime["executor"]["execute"];
  readSession?: GenerationBenchmarkRuntime["readSession"];
}): { runtime: GenerationBenchmarkRuntime; start: ReturnType<typeof vi.fn> } {
  const start = vi.fn(() => Promise.resolve(session([["open-detail"]])));
  return {
    start,
    runtime: {
      starter: { start },
      observer: {
        observe: overrides.observe ?? ((): Promise<
          Awaited<ReturnType<GenerationBenchmarkRuntime["observer"]["observe"]>>
        > => Promise.reject(new Error("unused")))
      },
      executor: {
        execute: overrides.execute ?? ((): Promise<
          Awaited<ReturnType<GenerationBenchmarkRuntime["executor"]["execute"]>>
        > => Promise.reject(new Error("unused")))
      },
      confirmation: {
        request: overrides.confirmation ?? ((): Promise<
          Awaited<ReturnType<GenerationBenchmarkRuntime["confirmation"]["request"]>>
        > => Promise.reject(new Error("unused")))
      },
      readSession: overrides.readSession ?? ((): Promise<GenerationSession> => Promise.reject(new Error("unused"))),
      resolvePlannedAction: overrides.resolvePlannedAction ?? ((): Promise<
        Awaited<ReturnType<GenerationBenchmarkRuntime["resolvePlannedAction"]>>
      > => Promise.reject(new Error("unused")))
    }
  };
}

function execute(
  runtime: GenerationBenchmarkRuntime,
  engine: BenchmarkEngine = "knowledge",
  routeTransitionIds: readonly string[] = ["open-detail"],
  expectedOutcome: "success" | "noRoute" = "success"
): Promise<BenchmarkCaseResult> {
  const executor = new GenerationBenchmarkExecutor({
    runtime,
    now: (): Date => new Date("2026-09-06T00:00:00.000Z")
  });
  return executor.execute({
    record: benchmarkCase(routeTransitionIds, expectedOutcome),
    engine,
    environment
  });
}

function oneStepThenGoalRuntime(routes: readonly string[][]): {
  runtime: GenerationBenchmarkRuntime;
  start: ReturnType<typeof vi.fn>;
} {
  const resolvedAction = {
    proposal,
    transitionId: "open-detail"
  } as unknown as Extract<
    ActionResolutionResult,
    { status: "resolved" }
  >["action"];
  const readSession = vi.fn()
    .mockResolvedValueOnce(session(routes))
    .mockResolvedValueOnce(session([]));
  return runtime({
    observe: (): Promise<typeof observation> => Promise.resolve(observation),
    readSession,
    resolvePlannedAction: (): Promise<ActionResolutionResult> =>
      Promise.resolve({ status: "resolved", action: resolvedAction }),
    confirmation: (): Promise<
      Awaited<ReturnType<GenerationBenchmarkRuntime["confirmation"]["request"]>>
    > => Promise.resolve({
      status: "approved",
      proposal,
      snapshot: snapshot()
    } as unknown as Awaited<
      ReturnType<GenerationBenchmarkRuntime["confirmation"]["request"]>
    >),
    execute: (): Promise<
      Awaited<ReturnType<GenerationBenchmarkRuntime["executor"]["execute"]>>
    > => Promise.resolve({
      status: "succeeded",
      step: { action: "wait" } as never,
      nextObservation: observation
    })
  });
}

describe("GenerationBenchmarkExecutor", () => {
  it("passes when the first observation already reaches the Goal", async () => {
    const { runtime: testRuntime } = runtime({
      observe: (): Promise<typeof observation> => Promise.resolve(observation),
      readSession: (): Promise<GenerationSession> => Promise.resolve(
        session([])
      )
    });

    const result = await execute(testRuntime, "knowledge", []);

    expect(result).toMatchObject({
      status: "passed",
      engine: "knowledge",
      routeCorrect: true,
      firstRunSuccess: true,
      recoveryCount: 0,
      llmCalls: 0
    });
  });

  it("marks a passed Goal as route-incorrect against a mismatched Ground Truth", async () => {
    const { runtime: testRuntime } = runtime({
      observe: (): Promise<typeof observation> => Promise.resolve(observation),
      readSession: (): Promise<GenerationSession> => Promise.resolve(
        session([])
      )
    });

    const result = await execute(testRuntime, "knowledge", ["other-path"]);

    expect(result).toMatchObject({
      status: "passed",
      routeCorrect: false
    });
  });

  it("accepts a planned route that matches the Ground Truth suffix after cold-start auto-advance", async () => {
    const { runtime: testRuntime } = oneStepThenGoalRuntime([["open-detail"]]);

    const result = await execute(
      testRuntime,
      "knowledge",
      ["boot-to-home", "open-detail"]
    );

    expect(result).toMatchObject({
      status: "passed",
      routeCorrect: true
    });
  });

  it("rejects a planned route that diverges inside the Ground Truth route", async () => {
    const { runtime: testRuntime } = oneStepThenGoalRuntime([["open-detail"]]);

    const result = await execute(
      testRuntime,
      "knowledge",
      ["boot-to-home", "open-sidebar"]
    );

    expect(result).toMatchObject({
      status: "passed",
      routeCorrect: false
    });
  });

  it("rejects a planned route longer than the Ground Truth route", async () => {
    const { runtime: testRuntime } = oneStepThenGoalRuntime([["open-detail", "open-detail-again"]]);

    const result = await execute(testRuntime, "knowledge", ["open-detail"]);

    expect(result).toMatchObject({
      status: "passed",
      routeCorrect: false
    });
  });

  it("rejects an empty planned route against a non-empty Ground Truth route", async () => {
    const { runtime: testRuntime } = runtime({
      observe: (): Promise<typeof observation> => Promise.resolve(observation),
      readSession: (): Promise<GenerationSession> => Promise.resolve(
        session([])
      )
    });

    const result = await execute(
      testRuntime,
      "knowledge",
      ["boot-to-home"]
    );

    expect(result).toMatchObject({
      status: "passed",
      routeCorrect: false
    });
  });

  it("executes one planned transition and accumulates phase timing", async () => {
    const firstObservation = {
      ...observation,
      planningTiming: { recognitionMs: 12, planningMs: 34 }
    };
    const readSession = vi.fn()
      .mockResolvedValueOnce(session([["open-detail"]]))
      .mockResolvedValueOnce(session([]));
    const { runtime: testRuntime } = runtime({
      observe: (): Promise<typeof firstObservation> =>
        Promise.resolve(firstObservation),
      readSession,
      resolvePlannedAction: (): Promise<
        Awaited<ReturnType<GenerationBenchmarkRuntime["resolvePlannedAction"]>>
      > => Promise.resolve({
        status: "resolved",
        action: {
          proposal,
          transitionId: "open-detail"
        } as unknown as Awaited<
          ReturnType<GenerationBenchmarkRuntime["resolvePlannedAction"]>
        > extends { status: "resolved"; action: infer T }
          ? T
          : never
      }),
      confirmation: (): Promise<
        Awaited<ReturnType<GenerationBenchmarkRuntime["confirmation"]["request"]>>
      > => Promise.resolve({
        status: "approved",
        proposal,
        snapshot: snapshot()
      } as unknown as Awaited<
        ReturnType<GenerationBenchmarkRuntime["confirmation"]["request"]>
      >),
      execute: (): Promise<
        Awaited<ReturnType<GenerationBenchmarkRuntime["executor"]["execute"]>>
      > => Promise.resolve({
        status: "succeeded",
        step: { action: "wait" } as never,
        timing: {
          freshnessCheckMs: 1,
          evidenceSetupMs: 1,
          logcatStartMs: 1,
          preActionObservationMs: 1,
          actionExecutionMs: 1,
          idleWaitMs: 1,
          postActionObservationMs: 1,
          expectationMs: 1,
          logcatStopMs: 1,
          totalMs: 42
        },
        nextObservation: {
          ...observation,
          planningTiming: { recognitionMs: 5, planningMs: 6 }
        }
      })
    });

    const result = await execute(testRuntime);

    expect(result).toMatchObject({
      status: "passed",
      routeCorrect: true,
      firstRunSuccess: true
    });
    expect(result.timing.recognitionMs).toBe(17);
    expect(result.timing.planningMs).toBe(40);
    expect(result.timing.executionMs).toBe(42);
    expect(result.timing.actionResolutionMs).toBeGreaterThanOrEqual(0);
  });  it("fails closed when the planner proposal requires risk confirmation", async () => {
    const { runtime: testRuntime } = runtime({
      observe: (): Promise<typeof observation> => Promise.resolve(observation),
      readSession: (): Promise<GenerationSession> => Promise.resolve(
        session([["open-detail"]])
      ),
      resolvePlannedAction: (): Promise<
        Awaited<ReturnType<GenerationBenchmarkRuntime["resolvePlannedAction"]>>
      > => Promise.resolve({
        status: "resolved",
        action: {
          proposal,
          transitionId: "open-detail"
        } as unknown as Awaited<
          ReturnType<GenerationBenchmarkRuntime["resolvePlannedAction"]>
        > extends { status: "resolved"; action: infer T }
          ? T
          : never
      }),
      confirmation: (): Promise<
        Awaited<ReturnType<GenerationBenchmarkRuntime["confirmation"]["request"]>>
      > => Promise.resolve({
        status: "confirmationRequired",
        revision: 2,
        challenge: {
          challengeId: "challenge-1",
          expiresAt: "2026-09-06T00:05:00.000Z"
        }
      } as unknown as Awaited<
        ReturnType<GenerationBenchmarkRuntime["confirmation"]["request"]>
      >)
    });

    const result = await execute(testRuntime);

    expect(result).toMatchObject({
      status: "failed",
      failureCode: "RISK_CONFIRMATION_REQUIRED"
    });
  });

  it("reports a noRoute expectation as passed when planning fails closed", async () => {
    const { runtime: testRuntime } = runtime({
      observe: (): Promise<never> => Promise.reject(
        new GenerationOperationError("NO_ROUTE", "No route")
      ),
      readSession: (): Promise<GenerationSession> => Promise.resolve(
        session([])
      )
    });

    const result = await execute(testRuntime, "knowledge", [], "noRoute");

    expect(result).toMatchObject({
      status: "passed",
      routeCorrect: true
    });
  });

  it("fails when the step executor reports a primary failure", async () => {
    const { runtime: testRuntime } = runtime({
      observe: (): Promise<typeof observation> => Promise.resolve(observation),
      readSession: (): Promise<GenerationSession> => Promise.resolve(
        session([["open-detail"]])
      ),
      resolvePlannedAction: (): Promise<
        Awaited<ReturnType<GenerationBenchmarkRuntime["resolvePlannedAction"]>>
      > => Promise.resolve({
        status: "resolved",
        action: {
          proposal,
          transitionId: "open-detail"
        } as unknown as Awaited<
          ReturnType<GenerationBenchmarkRuntime["resolvePlannedAction"]>
        > extends { status: "resolved"; action: infer T }
          ? T
          : never
      }),
      confirmation: (): Promise<
        Awaited<ReturnType<GenerationBenchmarkRuntime["confirmation"]["request"]>>
      > => Promise.resolve({
        status: "approved",
        proposal,
        snapshot: snapshot()
      } as unknown as Awaited<
        ReturnType<GenerationBenchmarkRuntime["confirmation"]["request"]>
      >),
      execute: (): Promise<
        Awaited<ReturnType<GenerationBenchmarkRuntime["executor"]["execute"]>>
      > => Promise.resolve({
        status: "failed",
        failure: { code: "LOCATOR_NOT_FOUND", message: "missing" }
      })
    });

    const result = await execute(testRuntime);

    expect(result).toMatchObject({
      status: "failed",
      failureCode: "LOCATOR_NOT_FOUND"
    });
  });

  it("recovers from a SNAPSHOT_STALE step failure by re-observing within the step budget", async () => {
    const resolvedAction = {
      proposal,
      transitionId: "open-detail"
    } as unknown as Extract<
      ActionResolutionResult,
      { status: "resolved" }
    >["action"];
    const observe = vi.fn((): Promise<typeof observation> =>
      Promise.resolve(observation)
    );
    const readSession = vi.fn()
      .mockResolvedValueOnce(session([["open-detail"]]))
      .mockResolvedValueOnce(session([["open-detail"]]))
      .mockResolvedValueOnce(session([]));
    const resolvePlannedAction = vi.fn((): Promise<ActionResolutionResult> =>
      Promise.resolve({ status: "resolved", action: resolvedAction })
    );
    const confirmation = vi.fn((): Promise<
      Awaited<ReturnType<GenerationBenchmarkRuntime["confirmation"]["request"]>>
    > => Promise.resolve({
      status: "approved",
      proposal,
      snapshot: snapshot()
    } as unknown as Awaited<
      ReturnType<GenerationBenchmarkRuntime["confirmation"]["request"]>
    >));
    const executeStep = vi.fn()
      .mockResolvedValueOnce({
        status: "failed",
        failure: {
          code: "SNAPSHOT_STALE",
          message: "Runtime snapshot changed after proposal"
        }
      })
      .mockResolvedValueOnce({
        status: "succeeded",
        step: { action: "wait" } as never,
        nextObservation: observation
      });
    const { runtime: testRuntime } = runtime({
      observe,
      readSession,
      resolvePlannedAction,
      confirmation,
      execute: executeStep
    });

    const result = await execute(testRuntime);

    expect(result).toMatchObject({
      status: "passed",
      routeCorrect: true
    });
    expect(observe).toHaveBeenCalledTimes(2);
    expect(executeStep).toHaveBeenCalledTimes(2);
  });

  it("fails with the last SNAPSHOT_STALE when retries exhaust the step budget", async () => {
    const resolvedAction = {
      proposal,
      transitionId: "open-detail"
    } as unknown as Extract<
      ActionResolutionResult,
      { status: "resolved" }
    >["action"];
    const observe = vi.fn((): Promise<typeof observation> =>
      Promise.resolve(observation)
    );
    const readSession = vi.fn((): Promise<GenerationSession> =>
      Promise.resolve(session([["open-detail"]]))
    );
    const resolvePlannedAction = vi.fn((): Promise<ActionResolutionResult> =>
      Promise.resolve({ status: "resolved", action: resolvedAction })
    );
    const confirmation = vi.fn((): Promise<
      Awaited<ReturnType<GenerationBenchmarkRuntime["confirmation"]["request"]>>
    > => Promise.resolve({
      status: "approved",
      proposal,
      snapshot: snapshot()
    } as unknown as Awaited<
      ReturnType<GenerationBenchmarkRuntime["confirmation"]["request"]>
    >));
    const executeStep = vi.fn((): Promise<
      Awaited<ReturnType<GenerationBenchmarkRuntime["executor"]["execute"]>>
    > => Promise.resolve({
      status: "failed",
      failure: {
        code: "SNAPSHOT_STALE",
        message: "Runtime snapshot changed after proposal"
      }
    }));
    const { runtime: testRuntime } = runtime({
      observe,
      readSession,
      resolvePlannedAction,
      confirmation,
      execute: executeStep
    });

    const result = await execute(testRuntime);

    expect(result).toMatchObject({
      status: "failed",
      failureCode: "SNAPSHOT_STALE",
      detail: "Runtime snapshot changed after proposal"
    });
    expect(executeStep).toHaveBeenCalledTimes(3);
    expect(observe).toHaveBeenCalledTimes(3);
  });

  it("recovers when confirmation throws SNAPSHOT_STALE once", async () => {
    const resolvedAction = {
      proposal,
      transitionId: "open-detail"
    } as unknown as Extract<
      ActionResolutionResult,
      { status: "resolved" }
    >["action"];
    const observe = vi.fn((): Promise<typeof observation> =>
      Promise.resolve(observation)
    );
    const readSession = vi.fn()
      .mockResolvedValueOnce(session([["open-detail"]]))
      .mockResolvedValueOnce(session([["open-detail"]]))
      .mockResolvedValueOnce(session([]));
    const resolvePlannedAction = vi.fn((): Promise<ActionResolutionResult> =>
      Promise.resolve({ status: "resolved", action: resolvedAction })
    );
    const confirmation = vi.fn()
      .mockRejectedValueOnce(new GenerationOperationError(
        "SNAPSHOT_STALE",
        "Referenced snapshot evidence is unavailable"
      ))
      .mockResolvedValueOnce({
        status: "approved",
        proposal,
        snapshot: snapshot()
      });
    const executeStep = vi.fn((): Promise<
      Awaited<ReturnType<GenerationBenchmarkRuntime["executor"]["execute"]>>
    > => Promise.resolve({
      status: "succeeded",
      step: { action: "wait" } as never,
      nextObservation: observation
    }));
    const { runtime: testRuntime } = runtime({
      observe,
      readSession,
      resolvePlannedAction,
      confirmation,
      execute: executeStep
    });

    const result = await execute(testRuntime);

    expect(result).toMatchObject({
      status: "passed",
      routeCorrect: true
    });
    expect(confirmation).toHaveBeenCalledTimes(2);
  });

  it("recovers when the planner throws SNAPSHOT_STALE once", async () => {
    const resolvedAction = {
      proposal,
      transitionId: "open-detail"
    } as unknown as Extract<
      ActionResolutionResult,
      { status: "resolved" }
    >["action"];
    const observe = vi.fn((): Promise<typeof observation> =>
      Promise.resolve(observation)
    );
    const readSession = vi.fn()
      .mockResolvedValueOnce(session([["open-detail"]]))
      .mockResolvedValueOnce(session([["open-detail"]]))
      .mockResolvedValueOnce(session([]));
    const resolvePlannedAction = vi.fn()
      .mockRejectedValueOnce(new GenerationOperationError(
        "SNAPSHOT_STALE",
        "Runtime snapshot changed after proposal"
      ))
      .mockResolvedValueOnce({
        status: "resolved",
        action: resolvedAction
      });
    const confirmation = vi.fn((): Promise<
      Awaited<ReturnType<GenerationBenchmarkRuntime["confirmation"]["request"]>>
    > => Promise.resolve({
      status: "approved",
      proposal,
      snapshot: snapshot()
    } as unknown as Awaited<
      ReturnType<GenerationBenchmarkRuntime["confirmation"]["request"]>
    >));
    const executeStep = vi.fn((): Promise<
      Awaited<ReturnType<GenerationBenchmarkRuntime["executor"]["execute"]>>
    > => Promise.resolve({
      status: "succeeded",
      step: { action: "wait" } as never,
      nextObservation: observation
    }));
    const { runtime: testRuntime } = runtime({
      observe,
      readSession,
      resolvePlannedAction,
      confirmation,
      execute: executeStep
    });

    const result = await execute(testRuntime);

    expect(result).toMatchObject({
      status: "passed",
      routeCorrect: true
    });
    expect(resolvePlannedAction).toHaveBeenCalledTimes(2);
  });
});
