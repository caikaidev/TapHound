import { resolve } from "node:path";

import { Command } from "commander";

import type { CliDependencies } from "../dependencies.js";
import {
  exitCodeForFailure,
  failureCodeFromUnknown,
  type FailureCode
} from "../../domain/failure.js";
import {
  failureOutput,
  writeJson,
  writeLine
} from "../output.js";
import { assertNoLegacyWorkspace } from "../workspace-guard.js";

interface ClassifyOptions {
  project: string;
  report: string;
  json?: boolean | undefined;
}

function writeFailure(
  dependencies: CliDependencies,
  json: boolean,
  code: FailureCode,
  message: string
): void {
  const exitCode = exitCodeForFailure(code);
  const output = failureOutput(exitCode, code, message);
  if (json) {
    writeJson(dependencies.stdout, output);
  } else {
    writeLine(dependencies.stderr, output.failure.message);
  }
  dependencies.setExitCode(exitCode);
}

export function createFailureCommand(
  dependencies: CliDependencies
): Command {
  const command = new Command("failure")
    .description("Classify Verification failures into structured reports")
    .addCommand(createClassifyCommand(dependencies));
  return command;
}

function createClassifyCommand(dependencies: CliDependencies): Command {
  return new Command("classify")
    .description("Classify a failed Verification report (offline, deterministic)")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .requiredOption("--report <path>", "Verification report.json path")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: ClassifyOptions): Promise<void> => {
      const json = options.json === true;
      if (dependencies.failureClassifier === undefined) {
        writeFailure(
          dependencies,
          json,
          "CONFIG_INVALID",
          "TapHound failure classification is not configured"
        );
        return;
      }
      try {
        await assertNoLegacyWorkspace(dependencies, options.project);
      } catch (error) {
        writeFailure(
          dependencies,
          json,
          failureCodeFromUnknown(error) ?? "CONFIG_INVALID",
          error instanceof Error ? error.message : String(error)
        );
        return;
      }
      try {
        const classification = await dependencies.failureClassifier.classify(
          resolve(options.project, options.report)
        );
        if (json) {
          writeJson(dependencies.stdout, classification);
        } else {
          writeLine(
            dependencies.stdout,
            `Failure classification: ${classification.type} (${classification.stage}) [${classification.code}]`
          );
          if (classification.expected !== undefined) {
            writeLine(
              dependencies.stdout,
              `  expected: ${classification.expected}`
            );
          }
          if (classification.actual !== undefined) {
            writeLine(
              dependencies.stdout,
              `  actual: ${classification.actual}`
            );
          }
          writeLine(
            dependencies.stdout,
            `  evidence: ${classification.evidenceRefs.join(", ") || "(none)"}`
          );
        }
        dependencies.setExitCode(0);
      } catch (error) {
        writeFailure(
          dependencies,
          json,
          failureCodeFromUnknown(error) ?? "CONFIG_INVALID",
          error instanceof Error ? error.message : String(error)
        );
      }
    });
}