import { resolve } from "node:path";

import { Command } from "commander";

import { TapHoundConfigSchema } from "../../domain/config.js";
import type { CliDependencies } from "../dependencies.js";
import {
  doctorMessage,
  errorMessage,
  failureOutput,
  writeJson,
  writeLine
} from "../output.js";

interface DoctorOptions {
  project: string;
  config: string;
  device?: string | undefined;
  json?: boolean | undefined;
}

async function configuredPackageName(
  dependencies: CliDependencies,
  options: DoctorOptions
): Promise<string | undefined> {
  try {
    return TapHoundConfigSchema.parse(await dependencies.readJson(
      resolve(options.project, options.config)
    )).run.packageName;
  } catch {
    return undefined;
  }
}

export function createDoctorCommand(dependencies: CliDependencies): Command {
  return new Command("doctor")
    .description("Check TapHound tools, permissions, application, and device")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", "taphound.config.json")
    .option("--device <serial>", "Select an online Android device")
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: DoctorOptions): Promise<void> => {
      try {
        const packageName = await configuredPackageName(dependencies, options);
        const report = await dependencies.doctor.run({
          ...(packageName === undefined ? {} : { packageName }),
          ...(options.device === undefined
            ? {}
            : { requestedDevice: options.device }),
          ...(dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal })
        });
        if (options.json === true) {
          writeJson(dependencies.stdout, report);
        } else {
          writeLine(dependencies.stdout, doctorMessage(report));
        }
        dependencies.setExitCode(report.status === "passed" ? 0 : 3);
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
