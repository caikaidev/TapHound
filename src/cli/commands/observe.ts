import { resolve } from "node:path";

import { Command } from "commander";

import { TapHoundConfigSchema } from "../../domain/config.js";
import { CONFIG_PATH } from "../../domain/workspace.js";
import type { ObserveReport } from "../../domain/observation.js";
import {
  exitCodeForFailure,
  failureCodeFromUnknown
} from "../../domain/failure.js";
import type { CliDependencies } from "../dependencies.js";
import {
  errorMessage,
  failureOutput,
  writeJson,
  writeLine
} from "../output.js";

interface ObserveOptions {
  project: string;
  config: string;
  device?: string | undefined;
  logcatLines?: number | undefined;
  json?: boolean | undefined;
}

function summarize(report: ObserveReport): string {
  const logcatLine = report.logcat === undefined
    ? "logcat: omitted"
    : `logcat: ${String(report.logcat.length)} line(s)`;
  return [
    `TapHound observe: ${report.packageName} on ${report.deviceSerial}`,
    `activity: ${report.activity ?? "(unavailable)"}`,
    `foreground: ${report.foreground.packageName}/${report.foreground.activity}`,
    `ui backend: ${report.uiBackend.id}`,
    `ui capture: ${String(report.uiCaptureDurationMs)}ms`,
    ...(report.uiCache === undefined
      ? []
      : [`ui cache: ${String(report.uiCache.hits)} hit(s), ${String(report.uiCache.misses)} miss(es), ${String(report.uiCache.capturesSaved)} capture(s) saved`]),
    `layout: ${String(report.layout.length)} element(s)`,
    logcatLine
  ].join("\n");
}

export function createObserveCommand(dependencies: CliDependencies): Command {
  return new Command("observe")
    .description("Capture a point-in-time device snapshot for the configured package")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", CONFIG_PATH)
    .option("--device <serial>", "Select an online Android device")
    .option(
      "--logcat-lines <n>",
      "Dump the last N logcat lines into the report",
      (value: string): number => Number.parseInt(value, 10)
    )
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: ObserveOptions): Promise<void> => {
      if (
        options.logcatLines !== undefined
        && (!Number.isFinite(options.logcatLines) || options.logcatLines < 0
          || !Number.isInteger(options.logcatLines))
      ) {
        const output = failureOutput(
          2,
          "CONFIG_INVALID",
          "--logcat-lines must be a non-negative integer"
        );
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else {
          writeLine(dependencies.stderr, output.failure.message);
        }
        dependencies.setExitCode(2);
        return;
      }

      let config;
      try {
        const rawConfig = await dependencies.readJson(
          resolve(options.project, options.config)
        );
        config = TapHoundConfigSchema.parse(rawConfig);
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
        const doctor = await dependencies.doctor.run({
          packageName: config.run.packageName,
          ...(config.ui?.backend === undefined
            ? {}
            : { requestedUiBackend: config.ui.backend }),
          ...(options.device === undefined
            ? {}
            : { requestedDevice: options.device }),
          ...(dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal })
        });
        if (doctor.status === "failed") {
          const output = failureOutput(
            3,
            doctor.failureCode ?? "ENVIRONMENT_MISSING_TOOL",
            doctor.checks.find((check) => check.status === "failed")?.message
              ?? "TapHound environment preflight failed"
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
        const observer = dependencies.observer(
          config.ui?.snapshotTimeoutMs ?? config.idle.timeoutMs,
          config.ui?.backend ?? "auto",
          config.ui?.cacheEnabled ?? true
        );
        const report = await observer.observe({
          packageName: config.run.packageName,
          deviceSerial,
          ...(options.logcatLines === undefined
            ? {}
            : { logcatLines: options.logcatLines }),
          ...(dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal })
        });
        if (options.json === true) {
          writeJson(dependencies.stdout, {
            status: "observed",
            exitCode: 0,
            report
          });
        } else {
          writeLine(dependencies.stdout, summarize(report));
        }
        dependencies.setExitCode(0);
      } catch (error) {
        const code = failureCodeFromUnknown(error) ?? "INTERNAL_ERROR";
        const exitCode = exitCodeForFailure(code);
        const output = failureOutput(exitCode, code, errorMessage(error));
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else {
          writeLine(dependencies.stderr, output.failure.message);
        }
        dependencies.setExitCode(exitCode);
      }
    });
}
