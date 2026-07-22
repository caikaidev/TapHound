import { resolve } from "node:path";

import { Command } from "commander";

import {
  GenerationOperationError
} from "../../application/generation/generation-starter.js";
import { TapHoundConfigSchema } from "../../domain/config.js";
import { ProjectContextSchema } from "../../domain/project-context.js";
import type { CliDependencies } from "../dependencies.js";
import {
  errorMessage,
  writeJson,
  writeLine
} from "../output.js";

interface GenerationStartOptions {
  project: string;
  config: string;
  context: string;
  device?: string | undefined;
  json?: boolean | undefined;
}

interface GenerationObserveOptions {
  project: string;
  session: string;
  json?: boolean | undefined;
}

type GenerationOptions = GenerationStartOptions | GenerationObserveOptions;

function writeFailure(
  dependencies: CliDependencies,
  options: GenerationOptions,
  exitCode: 1 | 2 | 3 | 4,
  code: string,
  error: unknown
): void {
  const output = {
    status: "error" as const,
    exitCode,
    failure: {
      code,
      message: errorMessage(error)
    }
  };
  if (options.json === true) {
    writeJson(dependencies.stdout, output);
  } else {
    writeLine(dependencies.stderr, output.failure.message);
  }
  dependencies.setExitCode(exitCode);
}

function createStartCommand(dependencies: CliDependencies): Command {
  return new Command("start")
    .description("Start a Core-owned generation session")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", "taphound.config.json")
    .requiredOption("--context <path>", "Project Context path")
    .option("--device <serial>", "Select an online Android device")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: GenerationStartOptions): Promise<void> => {
      let config;
      let context;
      try {
        config = TapHoundConfigSchema.parse(await dependencies.readJson(
          resolve(options.project, options.config)
        ));
        context = ProjectContextSchema.parse(await dependencies.readJson(
          resolve(options.project, options.context)
        ));
      } catch (error) {
        writeFailure(
          dependencies,
          options,
          2,
          "CONFIG_INVALID",
          error
        );
        return;
      }

      try {
        const doctor = await dependencies.doctor.run(
          options.project,
          dependencies.signal,
          options.device
        );
        if (doctor.status === "failed") {
          writeFailure(
            dependencies,
            options,
            3,
            doctor.failureCode ?? "ENVIRONMENT_MISSING_TOOL",
            doctor.checks.find((check) => check.status === "failed")?.message
              ?? "TapHound environment preflight failed"
          );
          return;
        }
        const deviceSerial = options.device ?? doctor.deviceSerial;
        if (deviceSerial === undefined) {
          throw new Error("Doctor did not select a device");
        }
        const project = await dependencies.projectDescriber.describe({
          projectRoot: options.project,
          config,
          ...(dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal })
        });
        const session = await dependencies.generationStarter.start({
          projectRoot: options.project,
          config,
          context,
          project,
          deviceSerial
        });
        const output = {
          status: "started" as const,
          exitCode: 0 as const,
          generationId: session.id,
          revision: session.revision,
          bindings: session.bindings,
          variables: session.variables,
          target: session.target
        };
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else {
          writeLine(
            dependencies.stdout,
            `Generation started: ${session.id}`
          );
        }
        dependencies.setExitCode(0);
      } catch (error) {
        if (error instanceof GenerationOperationError) {
          const exitCode = error.code === "CONTEXT_STALE" ? 1 : 2;
          writeFailure(
            dependencies,
            options,
            exitCode,
            error.code,
            error
          );
          return;
        }
        writeFailure(
          dependencies,
          options,
          4,
          "INTERNAL_ERROR",
          error
        );
      }
    });
}

function createObserveCommand(dependencies: CliDependencies): Command {
  return new Command("observe")
    .description("Observe and bind authoritative runtime state")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .requiredOption("--session <id>", "Generation session id")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: GenerationObserveOptions): Promise<void> => {
      try {
        const observation = await dependencies.runtimeObserver.observe({
          projectRoot: options.project,
          generationId: options.session,
          ...(dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal })
        });
        const output = {
          status: "observed" as const,
          exitCode: 0 as const,
          ...observation.binding,
          snapshot: observation.snapshot
        };
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else {
          writeLine(
            dependencies.stdout,
            `Generation observed at revision ${
              String(observation.binding.baseRevision)
            }`
          );
        }
        dependencies.setExitCode(0);
      } catch (error) {
        writeFailure(
          dependencies,
          options,
          4,
          "INTERNAL_ERROR",
          error
        );
      }
    });
}

export function createGenerationCommand(
  dependencies: CliDependencies
): Command {
  return new Command("generation")
    .description("Manage deterministic generation sessions")
    .addCommand(createStartCommand(dependencies))
    .addCommand(createObserveCommand(dependencies));
}
