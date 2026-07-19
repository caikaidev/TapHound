import { Command } from "commander";

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
  device?: string | undefined;
  json?: boolean | undefined;
}

export function createDoctorCommand(dependencies: CliDependencies): Command {
  return new Command("doctor")
    .description("Check APR tools, permissions, project, and device")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--device <serial>", "Select an online Android device")
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: DoctorOptions): Promise<void> => {
      try {
        const report = await dependencies.doctor.run(
          options.project,
          dependencies.signal,
          options.device
        );
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
