import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { Command } from "commander";

import { BenchmarkRunner } from "../../application/benchmark/benchmark-runner.js";
import {
  GenerationBenchmarkExecutor,
  type GenerationBenchmarkRuntime
} from "../../application/benchmark/generation-benchmark-executor.js";
import {
  ReplayBenchmarkExecutor,
  readStoredJourney
} from "../../application/benchmark/replay-benchmark-executor.js";
import { InteractionGraph } from "../../application/planning/interaction-graph.js";
import type {
  BenchmarkCaseResult,
  BenchmarkEngine,
  BenchmarkRunResult
} from "../../domain/benchmark.js";
import { TapHoundConfigSchema } from "../../domain/config.js";
import { InteractionActionSchema } from "../../domain/project-context.js";
import {
  BENCHMARKS_DIR,
  CONFIG_PATH,
  CONTEXT_INDEX_PATH
} from "../../domain/workspace.js";
import type { CliDependencies } from "../dependencies.js";
import { errorMessage, writeJson, writeLine } from "../output.js";

interface CommonOptions {
  project: string;
  json?: boolean | undefined;
}

interface RunOptions extends CommonOptions {
  config: string;
  context: string;
  device?: string | undefined;
  engine: string;
  case?: string[] | undefined;
}

interface BenchmarkOutput {
  status: string;
  exitCode: number;
  [key: string]: unknown;
}

interface ValidateOutput extends BenchmarkOutput {
  cases: {
    id: string;
    ok: boolean;
    issues: string[];
  }[];
}

interface BenchmarkCliRuntime {
  runtime: GenerationBenchmarkRuntime;
}

function requireGenerationRuntime(
  dependencies: CliDependencies,
  projectRoot: string,
  config: Parameters<
    NonNullable<CliDependencies["generationRuntime"]>
  >[0]["config"]
): BenchmarkCliRuntime {
  if (dependencies.generationRuntime === undefined) {
    throw new Error("Generation runtime is unavailable");
  }
  const runtime = dependencies.generationRuntime({ projectRoot, config });
  if (runtime.resolvePlannedAction === undefined) {
    throw new Error("Generation planning runtime is unavailable");
  }
  return {
    runtime: {
      starter: dependencies.generationStarter,
      observer: runtime.observer,
      executor: runtime.executor,
      confirmation: runtime.confirmation,
      readSession: runtime.readSession,
      resolvePlannedAction: runtime.resolvePlannedAction
    }
  };
}

function emit(
  dependencies: CliDependencies,
  options: CommonOptions,
  output: BenchmarkOutput,
  text: string
): void {
  if (options.json === true) {
    writeJson(dependencies.stdout, output);
  } else {
    writeLine(dependencies.stdout, text);
  }
  dependencies.setExitCode(output.exitCode);
}

function fail(
  dependencies: CliDependencies,
  options: CommonOptions,
  code: string,
  error: unknown
): void {
  const output = {
    status: "failed",
    exitCode: 2,
    code,
    message: errorMessage(error)
  };
  if (options.json === true) {
    writeJson(dependencies.stdout, output);
  } else {
    writeLine(dependencies.stderr, `${code}: ${output.message}`);
  }
  dependencies.setExitCode(2);
}

function requireBenchmarkStore(
  dependencies: CliDependencies
): NonNullable<CliDependencies["benchmark"]>["store"] {
  if (dependencies.benchmark === undefined) {
    throw new Error("Benchmark services are unavailable");
  }
  return dependencies.benchmark.store;
}

function requireJourneyResolver(
  dependencies: CliDependencies
): NonNullable<CliDependencies["journeyResolver"]> {
  if (dependencies.journeyResolver === undefined) {
    throw new Error("Journey Flow resolver is unavailable");
  }
  return dependencies.journeyResolver;
}

function requireKnowledge(
  dependencies: CliDependencies
): NonNullable<CliDependencies["knowledge"]> {
  if (dependencies.knowledge === undefined) {
    throw new Error("Knowledge services are unavailable");
  }
  return dependencies.knowledge;
}

function engineChoice(value: string): BenchmarkEngine {
  if (value === "legacy" || value === "baseFlow" || value === "knowledge") {
    return value;
  }
  throw new Error(
    `Unknown engine "${value}": expected legacy, baseFlow, or knowledge`
  );
}

function routeReachable(
  graph: InteractionGraph,
  startScreen: string,
  targetScreen: string
): boolean {
  const visited = new Set<string>([startScreen]);
  const queue = [startScreen];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current === targetScreen) return true;
    for (const edge of graph.edgesFrom(current)) {
      if (!visited.has(edge.transition.toScreen)) {
        visited.add(edge.transition.toScreen);
        queue.push(edge.transition.toScreen);
      }
    }
  }
  return false;
}

async function validate(
  dependencies: CliDependencies,
  options: CommonOptions & { context: string }
): Promise<ValidateOutput> {
  const store = requireBenchmarkStore(dependencies);
  const records = await store.readCases(options.project);
  const knowledge = await requireKnowledge(dependencies).load({
    projectRoot: options.project
  });
  const screens = new Set(knowledge.screens.map((screen) => screen.id));
  const transitions = new Set(knowledge.transitions.map(
    (transition) => transition.id
  ));
  const graph = new InteractionGraph(
    knowledge.transitions,
    InteractionActionSchema.options
  );
  const cases = records.map(({ benchmark, groundTruth }) => {
    const issues: string[] = [];
    if (!screens.has(benchmark.goal.targetScreen)) {
      issues.push(`Unknown target Screen: ${benchmark.goal.targetScreen}`);
    }
    if (groundTruth === undefined) {
      issues.push("No Ground Truth document");
    } else {
      if (!screens.has(groundTruth.startScreen)) {
        issues.push(`Unknown start Screen: ${groundTruth.startScreen}`);
      }
      if (!screens.has(groundTruth.targetScreen)) {
        issues.push(`Unknown target Screen: ${groundTruth.targetScreen}`);
      }
      for (const transitionId of groundTruth.routeTransitionIds) {
        if (!transitions.has(transitionId)) {
          issues.push(`Unknown route Transition: ${transitionId}`);
        }
      }
      if (
        groundTruth.expectedOutcome === "success"
        && !routeReachable(
          graph,
          groundTruth.startScreen,
          groundTruth.targetScreen
        )
      ) {
        issues.push(
          `No route from ${groundTruth.startScreen} to ${groundTruth.targetScreen}`
        );
      }
    }
    return { id: benchmark.id, ok: issues.length === 0, issues };
  });
  const valid = cases.every((entry) => entry.ok);
  return {
    status: valid ? "valid" : "invalid",
    exitCode: valid ? 0 : 2,
    knowledgeHash: knowledge.knowledgeHash,
    cases
  };
}

function compareMetrics(
  baseline: BenchmarkRunResult,
  candidate: BenchmarkRunResult
): Record<string, unknown> {
  return {
    eligibleCases: {
      baseline: baseline.metrics.eligibleCases,
      candidate: candidate.metrics.eligibleCases
    },
    passedCases: {
      baseline: baseline.metrics.passedCases,
      candidate: candidate.metrics.passedCases
    },
    firstRunSuccessRate: {
      baseline: baseline.metrics.firstRunSuccessRate,
      candidate: candidate.metrics.firstRunSuccessRate
    },
    routeAccuracy: {
      baseline: baseline.metrics.routeAccuracy,
      candidate: candidate.metrics.routeAccuracy
    },
    averageRecognitionMs: {
      baseline: baseline.metrics.averageRecognitionMs,
      candidate: candidate.metrics.averageRecognitionMs
    },
    averagePlanningMs: {
      baseline: baseline.metrics.averagePlanningMs,
      candidate: candidate.metrics.averagePlanningMs
    },
    averageRecoveryCount: {
      baseline: baseline.metrics.averageRecoveryCount,
      candidate: candidate.metrics.averageRecoveryCount
    },
    totalLlmCalls: {
      baseline: baseline.metrics.totalLlmCalls,
      candidate: candidate.metrics.totalLlmCalls
    }
  };
}

export function createBenchmarkCommand(dependencies: CliDependencies): Command {
  const command = new Command("benchmark")
    .description("Run and compare deterministic Journey engine benchmarks");

  command
    .command("validate")
    .description("Validate Benchmark Cases and Ground Truth references")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--context <path>", "Knowledge binding context", CONTEXT_INDEX_PATH)
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: CommonOptions & { context: string }): Promise<void> => {
      try {
        const output = await validate(dependencies, options);
        emit(
          dependencies,
          options,
          output,
          `Benchmark cases: ${String(output.cases.length)}`
        );
      } catch (error) {
        fail(dependencies, options, "BENCHMARK_INVALID", error);
      }
    });

  command
    .command("list")
    .description("List Benchmark Cases")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: CommonOptions): Promise<void> => {
      try {
        const store = requireBenchmarkStore(dependencies);
        const records = await store.readCases(options.project);
        const output = {
          status: "listed",
          exitCode: 0,
          directory: BENCHMARKS_DIR,
          cases: records.map(({ benchmark, groundTruth }) => ({
            id: benchmark.id,
            description: benchmark.description,
            tags: benchmark.tags,
            targetScreen: benchmark.goal.targetScreen,
            maxSteps: benchmark.goal.limits.maxSteps,
            maxReplans: benchmark.goal.limits.maxReplans,
            baseline: benchmark.baseline,
            hasGroundTruth: groundTruth !== undefined
          }))
        };
        emit(
          dependencies,
          options,
          output,
          `Benchmark cases: ${String(records.length)}`
        );
      } catch (error) {
        fail(dependencies, options, "BENCHMARK_INVALID", error);
      }
    });

  command
    .command("run")
    .description("Run Benchmark Cases with one engine on one device")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", CONFIG_PATH)
    .option("--context <path>", "Project Context path", CONTEXT_INDEX_PATH)
    .option("--device <serial>", "Select an online Android device")
    .requiredOption("--engine <engine>", "legacy, baseFlow, or knowledge")
    .option("--case <id...>", "Restrict to specific Case ids")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: RunOptions): Promise<void> => {
      try {
        const engine = engineChoice(options.engine);
        const store = requireBenchmarkStore(dependencies);
        const config = TapHoundConfigSchema.parse(
          await dependencies.readJson(resolve(options.project, options.config))
        );
        const doctor = await dependencies.doctor.run({
          packageName: config.run.packageName,
          ...(options.device === undefined
            ? {}
            : { requestedDevice: options.device }),
          ...(dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal })
        });
        if (doctor.status === "failed") {
          emit(dependencies, options, {
            status: "failed",
            exitCode: 3,
            code: doctor.failureCode ?? "ENVIRONMENT_MISSING_TOOL"
          }, "Benchmark environment preflight failed");
          return;
        }
        const deviceSerial = options.device ?? doctor.deviceSerial;
        if (deviceSerial === undefined) {
          throw new Error("Doctor did not select a device");
        }
        const context = (await dependencies.contextLoader.load({
          projectRoot: options.project,
          contextPath: resolve(options.project, options.context)
        })).context;
        const project = await dependencies.projectDescriber.describe({
          projectRoot: options.project,
          config,
          ...(dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal })
        });
        const knowledge = await requireKnowledge(dependencies).load({
          projectRoot: options.project,
          packageName: context.packageName
        });
        const toolVersions = Object.fromEntries(doctor.checks.flatMap(
          (check) => check.status === "passed" && check.version !== undefined
            ? [[check.name, check.version] as const]
            : []
        ));
        const environment = {
          projectRoot: options.project,
          config,
          context,
          project,
          deviceSerial,
          toolVersions,
          knowledgeHash: knowledge.knowledgeHash,
          ...(dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal })
        };
        const { runtime } = requireGenerationRuntime(
          dependencies,
          options.project,
          config
        );
        const knowledgeExecutor = new GenerationBenchmarkExecutor({
          runtime,
          now: (): Date => new Date()
        });
        const replayExecutor = new ReplayBenchmarkExecutor({
          journeyResolver: requireJourneyResolver(dependencies),
          verifier: dependencies.verifier,
          readJourney: readStoredJourney(dependencies.readJson),
          now: (): Date => new Date()
        });
        const runner = new BenchmarkRunner({
          store,
          executor: {
            execute: ({ record, engine: runnerEngine }): Promise<BenchmarkCaseResult> => (
              runnerEngine === "knowledge"
                ? knowledgeExecutor.execute({
                  record,
                  engine: runnerEngine,
                  environment
                })
                : replayExecutor.execute({
                  record,
                  engine: runnerEngine,
                  environment
                })
            )
          },
          now: (): Date => new Date(),
          createRunId: randomUUID
        });
        const { result, path } = await runner.run({
          projectRoot: options.project,
          engine,
          ...(options.case === undefined
            ? {}
            : { caseIds: options.case }),
          knowledgeHash: knowledge.knowledgeHash
        });
        emit(dependencies, options, {
          status: "ran",
          exitCode: 0,
          runId: result.runId,
          engine,
          resultPath: path,
          metrics: result.metrics
        }, `Benchmark run ${result.runId} at ${path}`);
      } catch (error) {
        fail(dependencies, options, "BENCHMARK_RUN_FAILED", error);
      }
    });

  command
    .command("compare")
    .description("Compare the aggregate metrics of two Benchmark runs")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .requiredOption("--baseline <runId>", "Baseline Benchmark run id")
    .requiredOption("--candidate <runId>", "Candidate Benchmark run id")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: CommonOptions & {
      baseline: string;
      candidate: string;
    }): Promise<void> => {
      try {
        const store = requireBenchmarkStore(dependencies);
        const baseline = await store.readResult(
          options.project,
          options.baseline
        );
        const candidate = await store.readResult(
          options.project,
          options.candidate
        );
        const output = {
          status: "compared",
          exitCode: 0,
          baseline: baseline.runId,
          candidate: candidate.runId,
          metrics: compareMetrics(baseline, candidate)
        };
        emit(
          dependencies,
          options,
          output,
          `Compared ${baseline.runId} -> ${candidate.runId}`
        );
      } catch (error) {
        fail(dependencies, options, "BENCHMARK_COMPARE_FAILED", error);
      }
    });

  return command;
}
