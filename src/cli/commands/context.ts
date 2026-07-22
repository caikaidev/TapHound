import { resolve } from "node:path";

import { Command } from "commander";

import type { ContextValidationResult } from "../../application/context/context-validator.js";
import { TapHoundConfigSchema } from "../../domain/config.js";
import type { CliDependencies } from "../dependencies.js";
import {
  errorMessage,
  failureOutput,
  writeJson,
  writeLine
} from "../output.js";

interface ContextOptions {
  project: string;
  config: string;
  context: string;
  json?: boolean | undefined;
}

type ContextCommandName = "validate" | "status";

function exitCodeForContext(
  command: ContextCommandName,
  result: ContextValidationResult
): 0 | 1 | 2 {
  if (result.status === "invalid") {
    return 2;
  }
  return command === "validate" && result.status === "stale" ? 1 : 0;
}

function createContextOperation(
  dependencies: CliDependencies,
  name: ContextCommandName
): Command {
  return new Command(name)
    .description(
      name === "validate"
        ? "Validate deterministic Project Context evidence"
        : "Observe deterministic Project Context status"
    )
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", "taphound.config.json")
    .requiredOption("--context <path>", "Project Context path")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: ContextOptions): Promise<void> => {
      let config;
      let context;
      try {
        config = TapHoundConfigSchema.parse(await dependencies.readJson(
          resolve(options.project, options.config)
        ));
        context = await dependencies.readJson(
          resolve(options.project, options.context)
        );
      } catch (error) {
        const output = failureOutput(
          2,
          "CONFIG_INVALID",
          errorMessage(error)
        );
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else {
          writeLine(dependencies.stderr, output.failure.message);
        }
        dependencies.setExitCode(2);
        return;
      }

      try {
        const result = await dependencies.contextValidator.validate({
          context,
          projectRoot: options.project,
          config
        });
        const exitCode = exitCodeForContext(name, result);
        const output = { ...result, exitCode };
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else {
          writeLine(
            dependencies.stdout,
            result.status === "valid"
              ? "Context: valid"
              : `Context: ${result.status} (${result.reason.message})`
          );
        }
        dependencies.setExitCode(exitCode);
      } catch (error) {
        const output = failureOutput(4, "INTERNAL_ERROR", errorMessage(error));
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else {
          writeLine(dependencies.stderr, output.failure.message);
        }
        dependencies.setExitCode(4);
      }
    });
}

export function createContextCommand(
  dependencies: CliDependencies
): Command {
  return new Command("context")
    .description("Validate or inspect Project Context")
    .addCommand(createContextOperation(dependencies, "validate"))
    .addCommand(createContextOperation(dependencies, "status"));
}
