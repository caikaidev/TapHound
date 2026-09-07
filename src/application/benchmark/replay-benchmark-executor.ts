import { JourneySchema, type Journey } from "../../domain/journey.js";
import type {
  BenchmarkCaseResult,
  BenchmarkEngine
} from "../../domain/benchmark.js";
import type { VerifyRuntime } from "../runtime/verify-runtime.js";
import type { JourneyResolver } from "../journey/journey-resolver.js";
import type { BenchmarkCaseRecord } from "../../ports/benchmark-store.js";
import type {
  BenchmarkExecutorEnvironment,
  EngineAwareBenchmarkExecutor
} from "./benchmark-executor.js";

const DEFAULT_DEVICE_ROLE = "default";

export class ReplayBenchmarkExecutor implements EngineAwareBenchmarkExecutor {
  public constructor(private readonly dependencies: {
    journeyResolver: Pick<JourneyResolver, "resolveFlow">;
    verifier: Pick<VerifyRuntime, "verify">;
    readJourney: (projectRoot: string, name: string) => Promise<Journey>;
    now: () => Date;
  }) {}

  public readonly execute = async (input: {
    record: BenchmarkCaseRecord;
    engine: BenchmarkEngine;
    environment: BenchmarkExecutorEnvironment;
  }): Promise<BenchmarkCaseResult> => {
    const { benchmark } = input.record;
    const startedAt = this.dependencies.now();
    const result = (
      status: BenchmarkCaseResult["status"],
      failureCode?: string,
      detail?: string
    ): BenchmarkCaseResult => ({
      caseId: benchmark.id,
      status,
      engine: input.engine,
      routeCorrect: null,
      firstRunSuccess: status === "passed",
      recoveryCount: 0,
      llmCalls: 0,
      llmInputTokens: 0,
      llmOutputTokens: 0,
      timing: {
        recognitionMs: 0,
        planningMs: 0,
        actionResolutionMs: 0,
        executionMs: 0,
        totalMs: this.dependencies.now().getTime() - startedAt.getTime()
      },
      ...(failureCode === undefined ? {} : { failureCode }),
      ...(detail === undefined ? {} : { detail })
    });

    const baseline = benchmark.baseline;
    const expectedKind = input.engine === "baseFlow"
      ? "baseFlow"
      : input.engine === "legacy"
        ? "journey"
        : undefined;
    if (expectedKind === undefined) {
      return result(
        "invalid",
        "BENCHMARK_ENGINE_MISMATCH",
        `Engine ${input.engine} does not use a recorded baseline`
      );
    }
    if (baseline === undefined || baseline.kind !== expectedKind) {
      return result(
        "invalid",
        "BENCHMARK_BASELINE_MISSING",
        `Engine ${input.engine} requires baseline.kind ${expectedKind}`
      );
    }

    let journey: Journey;
    try {
      journey = baseline.kind === "baseFlow"
        ? (await this.dependencies.journeyResolver.resolveFlow({
          projectRoot: input.environment.projectRoot,
          name: baseline.name
        })).journey
        : await this.dependencies.readJourney(
          input.environment.projectRoot,
          baseline.name
        );
      const verification = await this.dependencies.verifier.verify({
        config: input.environment.config,
        journey,
        projectRoot: input.environment.projectRoot,
        devices: [{
          role: journey.devices[0]?.role ?? DEFAULT_DEVICE_ROLE,
          deviceSerial: input.environment.deviceSerial
        }],
        toolVersions: input.environment.toolVersions,
        requireFocusedInput: true,
        generatedReplayPolicy: true,
        ...(input.environment.signal === undefined
          ? {}
          : { signal: input.environment.signal })
      });
      if (verification.status !== "passed" || verification.exitCode !== 0) {
        return result(
          "failed",
          verification.report.primaryFailure?.code ?? "BENCHMARK_REPLAY_FAILED",
          verification.report.primaryFailure?.message
            ?? `Baseline ${baseline.name} did not replay cleanly`
        );
      }
      return result("passed");
    } catch (error) {
      return result(
        "failed",
        "BENCHMARK_REPLAY_FAILED",
        error instanceof Error ? error.message : String(error)
      );
    }
  };
}

export function readStoredJourney(
  readJson: (path: string) => Promise<unknown>
): (projectRoot: string, name: string) => Promise<Journey> {
  return async (projectRoot, name) => JourneySchema.parse(
    await readJson(`${projectRoot}/.taphound/journeys/${name}.json`)
  );
}
