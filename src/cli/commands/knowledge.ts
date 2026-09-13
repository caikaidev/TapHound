import { resolve } from "node:path";

import { Command } from "commander";

import { InteractionGraph } from "../../application/planning/interaction-graph.js";
import { RoutePlanner } from "../../application/planning/route-planner.js";
import { FeatureMapProjector, renderFeatureMapMarkdown } from "../../application/knowledge/feature-map-projector.js";
import { ScreenDetector } from "../../application/recognition/screen-detector.js";
import { TapHoundConfigSchema } from "../../domain/config.js";
import {
  KnowledgePromotionSchema
} from "../../domain/knowledge-receipt.js";
import { GoalSpecSchema } from "../../domain/route.js";
import { RuntimeSnapshotSchema } from "../../domain/runtime-snapshot.js";
import {
  CONFIG_PATH,
  CONTEXT_INDEX_PATH
} from "../../domain/workspace.js";
import type { CliDependencies } from "../dependencies.js";
import { errorMessage, writeJson, writeLine } from "../output.js";

interface CommonOptions {
  project: string;
  json?: boolean | undefined;
}

interface BootstrapOptions extends CommonOptions {
  context: string;
  expectedHash?: string | undefined;
}

interface PromoteOptions extends CommonOptions {
  config: string;
  input: string;
}

interface EvolveOptions extends CommonOptions {
  config: string;
  expectedHash?: string | undefined;
}

interface GoalOptions extends CommonOptions {
  target: string;
  id?: string | undefined;
  parameter?: string[] | undefined;
  maxSteps: string;
  maxReplans: string;
}

interface FeatureMapOptions extends CommonOptions {
  markdown?: boolean | undefined;
}

interface PlanOptions extends CommonOptions {
  goal: string;
  snapshot: string;
}

function requireKnowledge(
  dependencies: CliDependencies
): NonNullable<CliDependencies["knowledge"]> {
  if (dependencies.knowledge === undefined) {
    throw new Error("Knowledge services are unavailable");
  }
  return dependencies.knowledge;
}

const featureMapProjector = new FeatureMapProjector({});

function failure(
  dependencies: CliDependencies,
  options: CommonOptions,
  error: unknown
): void {
  const output = {
    status: "failed",
    exitCode: 2,
    code: "KNOWLEDGE_INVALID",
    message: errorMessage(error)
  };
  if (options.json === true) {
    writeJson(dependencies.stdout, output);
  } else {
    writeLine(dependencies.stderr, `${output.code}: ${output.message}`);
  }
  dependencies.setExitCode(2);
}

function statusCommand(dependencies: CliDependencies): Command {
  return new Command("status")
    .description("Validate and hash the committed Knowledge Registry")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: CommonOptions): Promise<void> => {
      try {
        const bundle = await requireKnowledge(dependencies).load({
          projectRoot: options.project
        });
        const output = {
          status: "valid",
          exitCode: 0,
          knowledgeHash: bundle.knowledgeHash,
          revision: bundle.index.revision,
          packageName: bundle.index.packageName,
          counts: {
            anchors: bundle.anchors.length,
            screens: bundle.screens.length,
            transitions: bundle.transitions.length
          }
        };
        if (options.json === true) writeJson(dependencies.stdout, output);
        else writeLine(
          dependencies.stdout,
          `Knowledge ${bundle.knowledgeHash} (${String(bundle.screens.length)} Screens)`
        );
        dependencies.setExitCode(0);
      } catch (error) {
        failure(dependencies, options, error);
      }
    });
}

function bootstrapCommand(dependencies: CliDependencies): Command {
  return new Command("bootstrap")
    .description("Explicitly seed inferred Knowledge from Project Context")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--context <path>", "Project Context index", CONTEXT_INDEX_PATH)
    .option("--expected-hash <sha256>", "Reject a concurrent Registry change")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: BootstrapOptions): Promise<void> => {
      try {
        const loaded = await dependencies.contextLoader.load({
          projectRoot: options.project,
          contextPath: resolve(options.project, options.context)
        });
        const result = await requireKnowledge(dependencies).bootstrap({
          projectRoot: options.project,
          packageName: loaded.context.packageName,
          modules: loaded.modules,
          ...(options.expectedHash === undefined
            ? {}
            : { expectedKnowledgeHash: options.expectedHash })
        });
        const output = { status: "bootstrapped", exitCode: 0, ...result };
        if (options.json === true) writeJson(dependencies.stdout, output);
        else writeLine(
          dependencies.stdout,
          `Knowledge bootstrapped at revision ${String(result.revision)}`
        );
        dependencies.setExitCode(0);
      } catch (error) {
        failure(dependencies, options, error);
      }
    });
}

function promoteCommand(dependencies: CliDependencies): Command {
  return new Command("promote")
    .description("Explicitly promote receipt-backed Knowledge")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", CONFIG_PATH)
    .requiredOption("--input <path>", "Strict Knowledge promotion JSON")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: PromoteOptions): Promise<void> => {
      try {
        const config = TapHoundConfigSchema.parse(
          await dependencies.readJson(resolve(options.project, options.config))
        );
        const promotion = KnowledgePromotionSchema.parse(
          await dependencies.readJson(resolve(options.project, options.input))
        );
        const result = await requireKnowledge(dependencies).promote({
          projectRoot: options.project,
          packageName: config.run.packageName,
          promotion
        });
        const output = { status: "promoted", exitCode: 0, ...result };
        if (options.json === true) writeJson(dependencies.stdout, output);
        else writeLine(
          dependencies.stdout,
          `Knowledge promoted at revision ${String(result.revision)}`
        );
        dependencies.setExitCode(0);
      } catch (error) {
        failure(dependencies, options, error);
      }
    });
}

function evolveCommand(dependencies: CliDependencies): Command {
  return new Command("evolve")
    .description(
      "Fold runtime receipts into Knowledge observations and statuses"
    )
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", CONFIG_PATH)
    .option("--expected-hash <sha256>", "Reject a concurrent Registry change")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: EvolveOptions): Promise<void> => {
      try {
        const config = TapHoundConfigSchema.parse(
          await dependencies.readJson(resolve(options.project, options.config))
        );
        const result = await requireKnowledge(dependencies).evolve({
          projectRoot: options.project,
          packageName: config.run.packageName,
          ...(options.expectedHash === undefined
            ? {}
            : { expectedKnowledgeHash: options.expectedHash })
        });
        if (options.json === true) {
          writeJson(dependencies.stdout, { exitCode: 0, ...result });
        } else {
          writeLine(
            dependencies.stdout,
            result.status === "evolved"
              ? `Knowledge evolved at revision ${String(result.revision)} from ${String(result.foldedReceipts)} receipt(s)`
              : `Knowledge unchanged after ${String(result.foldedReceipts)} receipt(s)`
          );
        }
        dependencies.setExitCode(0);
      } catch (error) {
        failure(dependencies, options, error);
      }
    });
}

function parseGoalParameters(
  values: readonly string[]
): Record<string, string> {
  const parameters: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0) {
      throw new Error(`Goal parameter must be key=value: ${value}`);
    }
    const key = value.slice(0, separator);
    if (Object.prototype.hasOwnProperty.call(parameters, key)) {
      throw new Error(`Goal parameter is repeated: ${key}`);
    }
    parameters[key] = value.slice(separator + 1);
  }
  return parameters;
}

function goalCommand(dependencies: CliDependencies): Command {
  return new Command("goal")
    .description("Draft a strict Goal Spec for a known target Screen")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .requiredOption("--target <screenId>", "Target Screen id from Knowledge")
    .option("--id <goalId>", "Goal id", (value: string) => value)
    .option(
      "--parameter <key=value...>",
      "Literal Goal parameters",
      (value: string, previous: string[]): string[] => [...previous, value],
      []
    )
    .option("--max-steps <n>", "Maximum Journey steps", "10")
    .option("--max-replans <n>", "Maximum re-plans", "2")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: GoalOptions): Promise<void> => {
      try {
        const knowledge = await requireKnowledge(dependencies).load({
          projectRoot: options.project
        });
        if (
          !knowledge.screens.some((screen) => screen.id === options.target)
        ) {
          throw new Error(`Unknown target Screen: ${options.target}`);
        }
        const goal = GoalSpecSchema.parse({
          version: 1,
          id: options.id ?? `goal-${options.target}`,
          targetScreen: options.target,
          parameters: parseGoalParameters(options.parameter ?? []),
          limits: {
            maxSteps: Number(options.maxSteps),
            maxReplans: Number(options.maxReplans)
          }
        });
        if (options.json === true) {
          writeJson(dependencies.stdout, { status: "drafted", exitCode: 0, goal });
        } else {
          writeLine(dependencies.stdout, JSON.stringify(goal, null, 2));
        }
        dependencies.setExitCode(0);
      } catch (error) {
        failure(dependencies, options, error);
      }
    });
}

function planCommand(dependencies: CliDependencies): Command {
  return new Command("plan")
    .description("Recognize a fixed Snapshot and deterministically plan a Route")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .requiredOption("--goal <path>", "Strict Goal Spec JSON")
    .requiredOption("--snapshot <path>", "Runtime Snapshot JSON")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: PlanOptions): Promise<void> => {
      try {
        const knowledge = await requireKnowledge(dependencies).load({
          projectRoot: options.project
        });
        const goal = GoalSpecSchema.parse(
          await dependencies.readJson(resolve(options.project, options.goal))
        );
        const snapshot = RuntimeSnapshotSchema.parse(
          await dependencies.readJson(resolve(options.project, options.snapshot))
        );
        const detection = new ScreenDetector().detect({
          snapshot,
          anchors: knowledge.anchors,
          screens: knowledge.screens
        });
        if (detection.status !== "matched") {
          const output = {
            status: "failed",
            exitCode: 1,
            code: detection.status === "ambiguous"
              ? "SCREEN_AMBIGUOUS"
              : "SCREEN_UNKNOWN",
            detection
          };
          if (options.json === true) writeJson(dependencies.stdout, output);
          else writeLine(dependencies.stderr, output.code);
          dependencies.setExitCode(1);
          return;
        }
        const result = new RoutePlanner().plan({
          goal,
          currentScreen: detection.screenId,
          knowledgeHash: knowledge.knowledgeHash,
          screens: knowledge.screens,
          graph: new InteractionGraph(knowledge.transitions),
          now: new Date()
        });
        if (result.status === "failed") {
          const output = {
            status: "failed",
            exitCode: 1,
            ...result.failure
          };
          if (options.json === true) writeJson(dependencies.stdout, output);
          else writeLine(dependencies.stderr, result.failure.message);
          dependencies.setExitCode(1);
          return;
        }
        const output = {
          status: "planned",
          exitCode: 0,
          detection,
          route: result.route
        };
        if (options.json === true) writeJson(dependencies.stdout, output);
        else writeLine(
          dependencies.stdout,
          `Route planned with ${String(result.route.segments.length)} Transition(s)`
        );
        dependencies.setExitCode(0);
      } catch (error) {
        failure(dependencies, options, error);
      }
    });
}

function receiptsCommand(dependencies: CliDependencies): Command {
  return new Command("receipts")
    .description("List immutable runtime Knowledge receipts")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: CommonOptions): Promise<void> => {
      try {
        const receipts = await requireKnowledge(dependencies).listReceipts(
          options.project
        );
        if (options.json === true) {
          writeJson(dependencies.stdout, {
            status: "listed",
            exitCode: 0,
            receipts
          });
        } else {
          writeLine(
            dependencies.stdout,
            receipts.length === 0
              ? "No Knowledge receipts"
              : receipts.map((receipt) => `${receipt.id}\t${receipt.kind}`).join("\n")
          );
        }
        dependencies.setExitCode(0);
      } catch (error) {
        failure(dependencies, options, error);
      }
    });
}

function featureMapCommand(dependencies: CliDependencies): Command {
  return new Command("feature-map")
    .description("Project committed Knowledge into a deterministic agent-friendly Feature Map")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--json", "Emit the structured projection as one JSON value")
    .option("--markdown", "Emit the low-token Markdown projection")
    .action(async (options: FeatureMapOptions): Promise<void> => {
      try {
        const bundle = await requireKnowledge(dependencies).load({
          projectRoot: options.project
        });
        const projection = featureMapProjector.project(bundle);
        if (options.json === true) {
          writeJson(dependencies.stdout, projection);
        } else if (options.markdown === true) {
          writeLine(dependencies.stdout, renderFeatureMapMarkdown(projection));
        } else {
          writeLine(
            dependencies.stdout,
            `Feature Map: ${String(projection.features.length)} feature(s), ${String(projection.entryScreens.length)} entry screen(s), hash ${projection.knowledgeHash.slice(0, 12)}`
          );
        }
        dependencies.setExitCode(0);
      } catch (error) {
        failure(dependencies, options, error);
      }
    });
}

export function createKnowledgeCommand(
  dependencies: CliDependencies
): Command {
  return new Command("knowledge")
    .description("Manage committed runtime Knowledge")
    .addCommand(statusCommand(dependencies))
    .addCommand(bootstrapCommand(dependencies))
    .addCommand(goalCommand(dependencies))
    .addCommand(planCommand(dependencies))
    .addCommand(receiptsCommand(dependencies))
    .addCommand(promoteCommand(dependencies))
    .addCommand(evolveCommand(dependencies))
    .addCommand(featureMapCommand(dependencies));
}
