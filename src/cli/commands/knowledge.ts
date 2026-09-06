import { resolve } from "node:path";

import { Command } from "commander";

import { InteractionGraph } from "../../application/planning/interaction-graph.js";
import { RoutePlanner } from "../../application/planning/route-planner.js";
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

export function createKnowledgeCommand(
  dependencies: CliDependencies
): Command {
  return new Command("knowledge")
    .description("Manage committed runtime Knowledge")
    .addCommand(statusCommand(dependencies))
    .addCommand(bootstrapCommand(dependencies))
    .addCommand(planCommand(dependencies))
    .addCommand(receiptsCommand(dependencies))
    .addCommand(promoteCommand(dependencies));
}
