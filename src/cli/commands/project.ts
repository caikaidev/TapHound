import { resolve } from "node:path";

import { Command } from "commander";

import { TapHoundConfigSchema } from "../../domain/config.js";
import { CONFIG_PATH } from "../../domain/workspace.js";
import type { CliDependencies } from "../dependencies.js";
import {
  errorMessage,
  failureOutput,
  writeJson,
  writeLine
} from "../output.js";

interface ProjectDescribeOptions {
  project: string;
  config: string;
  json?: boolean | undefined;
}

function writeFailure(
  dependencies: CliDependencies,
  options: ProjectDescribeOptions,
  exitCode: 2 | 4,
  error: unknown
): void {
  const output = failureOutput(
    exitCode,
    exitCode === 2 ? "CONFIG_INVALID" : "INTERNAL_ERROR",
    errorMessage(error)
  );
  if (options.json === true) {
    writeJson(dependencies.stdout, output);
  } else {
    writeLine(dependencies.stderr, output.failure.message);
  }
  dependencies.setExitCode(exitCode);
}

export function createProjectCommand(
  dependencies: CliDependencies
): Command {
  const describe = new Command("describe")
    .description("Describe stable Android project facts")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", CONFIG_PATH)
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: ProjectDescribeOptions): Promise<void> => {
      let config;
      try {
        config = TapHoundConfigSchema.parse(await dependencies.readJson(
          resolve(options.project, options.config)
        ));
      } catch (error) {
        writeFailure(dependencies, options, 2, error);
        return;
      }

      try {
        const description = await dependencies.projectDescriber.describe({
          projectRoot: options.project,
          config,
          ...(dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal })
        });
        const output = {
          status: "described" as const,
          exitCode: 0 as const,
          ...description
        };
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else {
          writeLine(
            dependencies.stdout,
            `${description.packageName}\nActivity: ${description.launchActivity}`
          );
        }
        dependencies.setExitCode(0);
      } catch (error) {
        writeFailure(dependencies, options, 4, error);
      }
    });

  return new Command("project")
    .description("Inspect stable Android project facts")
    .addCommand(describe);
}
