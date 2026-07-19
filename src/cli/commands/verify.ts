import { resolve } from "node:path";

import { Command } from "commander";

import { AprConfigSchema } from "../../domain/config.js";
import { JourneySchema } from "../../domain/journey.js";
import type { CliDependencies } from "../dependencies.js";
import {
  errorMessage,
  failureOutput,
  writeJson,
  writeLine
} from "../output.js";

interface VerifyOptions {
  project: string;
  config: string;
  journey: string;
  device?: string | undefined;
  package?: string | undefined;
  activity?: string | undefined;
  reports?: string | undefined;
  json?: boolean | undefined;
}

function toolVersions(checks: Awaited<ReturnType<CliDependencies["doctor"]["run"]>>["checks"]): Record<string, string> {
  return Object.fromEntries(checks.flatMap((check) => (
    check.version === undefined
      || !["node", "adb", "android"].includes(check.name)
      ? []
      : [[check.name, check.version]]
  )));
}

export function createVerifyCommand(dependencies: CliDependencies): Command {
  return new Command("verify")
    .description("Deterministically verify an APR Journey")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "APR config path", "apr.config.json")
    .requiredOption("--journey <path>", "APR Journey path")
    .option("--device <serial>", "Select an online Android device")
    .option("--package <name>", "Override run.packageName")
    .option("--activity <name>", "Override run.activity")
    .option("--reports <path>", "Override report output directory")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: VerifyOptions): Promise<void> => {
      let config;
      let journey;
      try {
        const rawConfig = await dependencies.readJson(
          resolve(options.project, options.config)
        );
        const parsed = AprConfigSchema.parse(rawConfig);
        config = AprConfigSchema.parse({
          ...parsed,
          run: {
            packageName: options.package ?? parsed.run.packageName,
            activity: options.activity ?? parsed.run.activity
          },
          artifactsDir: options.reports ?? parsed.artifactsDir
        });
        journey = JourneySchema.parse(await dependencies.readJson(
          resolve(options.project, options.journey)
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
        writeLine(dependencies.stderr, `APR: verifying ${journey.name}`);
        const result = await dependencies.verifier.verify({
          config,
          journey,
          projectRoot: options.project,
          deviceSerial,
          toolVersions: toolVersions(doctor.checks),
          ...(dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal })
        });
        if (options.json === true) {
          writeJson(dependencies.stdout, result);
        } else {
          writeLine(
            dependencies.stdout,
            `APR verify: ${result.status.toUpperCase()}\nReport: ${result.reportPath}`
          );
        }
        dependencies.setExitCode(result.exitCode);
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
