import { resolve } from "node:path";

import { Command } from "commander";

import { TapHoundConfigSchema } from "../../domain/config.js";
import { CONFIG_PATH } from "../../domain/workspace.js";
import type { CliDependencies } from "../dependencies.js";
import { errorMessage, writeJson, writeLine } from "../output.js";

interface CommonOptions {
  project: string;
  json?: boolean | undefined;
}

interface RehashOptions extends CommonOptions {
  config: string;
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
            screens: bundle.screens.length
          }
        };
        if (options.json === true) writeJson(dependencies.stdout, output);
        else writeLine(
          dependencies.stdout,
          `Knowledge ${bundle.knowledgeHash} (${String(bundle.anchors.length)} Anchors, ${String(bundle.screens.length)} Screens)`
        );
        dependencies.setExitCode(0);
      } catch (error) {
        failure(dependencies, options, error);
      }
    });
}

function rehashCommand(dependencies: CliDependencies): Command {
  return new Command("rehash")
    .description("Rebuild the Knowledge index from committed Anchor and Screen documents")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", CONFIG_PATH)
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: RehashOptions): Promise<void> => {
      try {
        const config = TapHoundConfigSchema.parse(await dependencies.readJson(
          resolve(options.project, options.config)
        ));
        const result = await requireKnowledge(dependencies).rehash({
          projectRoot: options.project,
          packageName: config.run.packageName
        });
        const output = {
          status: result.changed ? "rehashed" : "unchanged",
          exitCode: 0,
          ...result
        };
        if (options.json === true) writeJson(dependencies.stdout, output);
        else writeLine(
          dependencies.stdout,
          `Knowledge ${output.status} at revision ${String(result.revision)} (${String(result.anchors)} Anchors, ${String(result.screens)} Screens)`
        );
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
    .description("Validate and index committed semantic Anchors and Screens")
    .addCommand(statusCommand(dependencies))
    .addCommand(rehashCommand(dependencies));
}
