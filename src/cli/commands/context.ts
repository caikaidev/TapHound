import { resolve } from "node:path";

import { Command } from "commander";

import {
  ContextLoadError
} from "../../application/context/context-loader.js";
import {
  ContextRefreshError,
  type ContextRefreshResult
} from "../../application/context/context-refresher.js";
import type {
  ContextValidationResult
} from "../../application/context/context-validator.js";
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
  module?: string[] | undefined;
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

function loadFailureResult(error: ContextLoadError): ContextValidationResult {
  return error.code === "CONTEXT_STALE"
    ? {
        status: "stale",
        reason: {
          code: "EVIDENCE_HASH_MISMATCH",
          message: error.message
        }
      }
    : {
        status: "invalid",
        reason: {
          code: "CONTEXT_SCHEMA_INVALID",
          message: error.message
        }
      };
}

function writeContextResult(
  dependencies: CliDependencies,
  options: ContextOptions,
  name: ContextCommandName,
  result: ContextValidationResult,
  details: Record<string, unknown> = {}
): void {
  const exitCode = exitCodeForContext(name, result);
  const output = { ...result, ...details, exitCode };
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
    .requiredOption("--context <path>", "Project Context index path")
    .option("--module <id...>", "Select Context modules")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: ContextOptions): Promise<void> => {
      let config;
      try {
        config = TapHoundConfigSchema.parse(await dependencies.readJson(
          resolve(options.project, options.config)
        ));
      } catch (error) {
        const output = failureOutput(2, "CONFIG_INVALID", errorMessage(error));
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else {
          writeLine(dependencies.stderr, output.failure.message);
        }
        dependencies.setExitCode(2);
        return;
      }

      try {
        const loaded = await dependencies.contextLoader.load({
          projectRoot: options.project,
          contextPath: resolve(options.project, options.context),
          ...(options.module === undefined ? {} : { moduleIds: options.module }),
          allowIncomplete: name === "status"
        });
        const result = await dependencies.contextValidator.validate({
          context: loaded.context,
          projectRoot: options.project,
          config
        });
        writeContextResult(dependencies, options, name, result, {
          contextSelection: loaded.context.selection,
          modules: loaded.modules.map((module) => ({
            id: module.moduleId,
            status: module.status
          }))
        });
      } catch (error) {
        if (error instanceof ContextLoadError) {
          writeContextResult(
            dependencies,
            options,
            name,
            loadFailureResult(error)
          );
          return;
        }
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

function createContextListCommand(dependencies: CliDependencies): Command {
  return new Command("list")
    .description("List Project Context modules without loading shards")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .requiredOption("--context <path>", "Project Context index path")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: Pick<
      ContextOptions,
      "project" | "context" | "json"
    >): Promise<void> => {
      try {
        const { bundle, indexHash } = await dependencies.contextLoader.readIndex({
          projectRoot: options.project,
          contextPath: resolve(options.project, options.context)
        });
        const output = {
          status: "listed",
          exitCode: 0,
          version: bundle.version,
          packageName: bundle.packageName,
          launchActivity: bundle.launchActivity,
          indexHash,
          modules: bundle.modules
        };
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else {
          for (const module of bundle.modules) {
            writeLine(
              dependencies.stdout,
              `${module.id}: ${module.status} (${module.contextPath})`
            );
          }
        }
        dependencies.setExitCode(0);
      } catch (error) {
        const output = error instanceof ContextLoadError
          ? {
              status: "error" as const,
              exitCode: 2 as const,
              failure: {
                code: error.code,
                message: error.message
              }
            }
          : failureOutput(4, "INTERNAL_ERROR", errorMessage(error));
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else {
          writeLine(dependencies.stderr, output.failure.message);
        }
        dependencies.setExitCode(output.exitCode);
      }
    });
}

interface ContextRefreshOptions {
  project: string;
  context: string;
  module?: string[] | undefined;
  acceptSourceChanges?: boolean | undefined;
  json?: boolean | undefined;
}

function refreshExitCode(result: ContextRefreshResult): 0 | 1 {
  return result.status === "blocked" ? 1 : 0;
}

function writeRefreshText(
  dependencies: CliDependencies,
  result: ContextRefreshResult
): void {
  writeLine(dependencies.stdout, `Context: ${result.status}`);
  for (const scope of result.scopes) {
    if (
      scope.semanticBackfilled === 0
      && scope.formattingRehashed === 0
      && scope.semanticChanged.length === 0
      && scope.unresolved.length === 0
      && !scope.inventoryChanged
    ) {
      continue;
    }
    writeLine(
      dependencies.stdout,
      `${scope.id}: semantic ${String(scope.semanticBackfilled)}`
      + `, rehashed ${String(scope.formattingRehashed)}`
      + `, changed ${String(scope.semanticChanged.length)}`
      + `, unresolved ${String(scope.unresolved.length)}`
      + (scope.inventoryChanged ? ", inventory changed" : "")
    );
  }
  for (const block of result.blocked) {
    writeLine(dependencies.stderr, `${block.code}: ${block.message}`);
  }
}

function createContextRefreshCommand(dependencies: CliDependencies): Command {
  return new Command("refresh")
    .description("Recompute Project Context evidence hashes without analysis")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .requiredOption("--context <path>", "Project Context index path")
    .option("--module <id...>", "Refresh only the listed Context modules")
    .option(
      "--accept-source-changes",
      "Also rehash evidence whose semantics changed"
    )
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: ContextRefreshOptions): Promise<void> => {
      try {
        const result = await dependencies.contextRefresher.refresh({
          projectRoot: options.project,
          contextPath: resolve(options.project, options.context),
          ...(options.module === undefined ? {} : { moduleIds: options.module }),
          ...(options.acceptSourceChanges === undefined
            ? {}
            : { acceptSourceChanges: options.acceptSourceChanges })
        });
        const exitCode = refreshExitCode(result);
        if (options.json === true) {
          writeJson(dependencies.stdout, { ...result, exitCode });
        } else {
          writeRefreshText(dependencies, result);
        }
        dependencies.setExitCode(exitCode);
      } catch (error) {
        const output = error instanceof ContextRefreshError
          ? {
              status: "error" as const,
              exitCode: 2 as const,
              failure: { code: error.code, message: error.message }
            }
          : error instanceof ContextLoadError
            ? {
                status: "error" as const,
                exitCode: 2 as const,
                failure: { code: error.code, message: error.message }
              }
            : failureOutput(4, "INTERNAL_ERROR", errorMessage(error));
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else {
          writeLine(dependencies.stderr, output.failure.message);
        }
        dependencies.setExitCode(output.exitCode);
      }
    });
}

export function createContextCommand(
  dependencies: CliDependencies
): Command {
  return new Command("context")
    .description("Validate or inspect Project Context")
    .addCommand(createContextOperation(dependencies, "validate"))
    .addCommand(createContextOperation(dependencies, "status"))
    .addCommand(createContextListCommand(dependencies))
    .addCommand(createContextRefreshCommand(dependencies));
}
