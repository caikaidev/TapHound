import { resolve } from "node:path";

import { Command } from "commander";

import { TapHoundConfigSchema } from "../../domain/config.js";
import type { CliDependencies } from "../dependencies.js";
import {
  errorMessage,
  failureOutput,
  writeJson,
  writeLine
} from "../output.js";

interface RecordOptions {
  project: string;
  config: string;
  device?: string | undefined;
  name: string;
  output: string;
  json?: boolean | undefined;
}

export function createRecordCommand(dependencies: CliDependencies): Command {
  return new Command("record")
    .description("Interactively record an APR Journey")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "APR config path", "apr.config.json")
    .option("--device <serial>", "Select an online Android device")
    .requiredOption("--name <name>", "Journey name")
    .requiredOption("--output <path>", "Journey output path")
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: RecordOptions): Promise<void> => {
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
        const doctor = await dependencies.doctor.run(
          options.project,
          dependencies.signal,
          options.device
        );
        if (doctor.status === "failed") {
          const output = failureOutput(
            3,
            doctor.failureCode ?? "ENVIRONMENT_MISSING_TOOL",
            doctor.checks.find((check) => check.status === "failed")?.message
              ?? "APR environment preflight failed"
          );
          if (options.json === true) {
            writeJson(dependencies.stdout, output);
          } else {
            writeLine(dependencies.stderr, output.failure.message);
          }
          dependencies.setExitCode(3);
          return;
        }
        const deviceSerial = options.device ?? doctor.deviceSerial;
        if (deviceSerial === undefined) {
          throw new Error("Doctor did not select a device");
        }
        const result = await dependencies.recorder.record({
          config,
          projectRoot: options.project,
          deviceSerial,
          journeyName: options.name,
          outputPath: resolve(options.project, options.output),
          ...(dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal })
        });
        if (options.json === true) {
          writeJson(dependencies.stdout, result);
        } else if (result.status === "completed") {
          writeLine(
            dependencies.stdout,
            `Recorded ${String(result.stepsRecorded)} step${result.stepsRecorded === 1 ? "" : "s"}`
          );
        } else {
          writeLine(
            dependencies.stderr,
            result.status === "failed" ? result.message : "Recording cancelled"
          );
        }
        dependencies.setExitCode(result.status === "failed" ? 1 : 0);
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
