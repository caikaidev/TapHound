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


interface CaptureOptions {
  project: string;
  report: string;
  id?: string | undefined;
  journeySha256?: string | undefined;
  contractSha256?: string | undefined;
  out: string;
  json?: boolean | undefined;
}

interface CompareOptions {
  project: string;
  baseline: string;
  report: string;
  journeySha256?: string | undefined;
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

export function createBaselineCommand(
  dependencies: CliDependencies
): Command {
  const command = new Command("baseline")
    .description("Capture and compare behavior Baselines against Verification reports")
    .addCommand(createCaptureCommand(dependencies))
    .addCommand(createCompareCommand(dependencies));
  return command;
}

function createCaptureCommand(dependencies: CliDependencies): Command {
  return new Command("capture")
    .description("Capture a Baseline from a passing Verification report (offline)")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .requiredOption("--report <path>", "Verification report.json path")
    .option("--id <name>", "Baseline id (defaults to the report runId)")
    .option("--journey-sha256 <sha256>", "Journey sha256 binding")
    .option("--contract-sha256 <sha256>", "Contract sha256 binding")
    .requiredOption("--out <path>", "Baseline JSON output path")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: CaptureOptions): Promise<void> => {
      const json = options.json === true;
      if (dependencies.baselineService === undefined) {
        writeFailure(
          dependencies,
          json,
          "CONFIG_INVALID",
          "TapHound baseline capture is not configured"
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
        const baseline = await dependencies.baselineService.captureFromReport(
          resolve(options.project, options.report),
          {
            id: options.id,
            journeySha256: options.journeySha256,
            contractSha256: options.contractSha256
          }
        );
        await dependencies.baselineService.write({
          path: resolve(options.project, options.out),
          baseline
        });
        if (json) {
          writeJson(dependencies.stdout, baseline);
        } else {
          writeLine(
            dependencies.stdout,
            `Baseline ${baseline.id} captured (${String(baseline.activities.length)} activity facts, ${String(baseline.elements.length)} element facts)`
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

function createCompareCommand(dependencies: CliDependencies): Command {
  return new Command("compare")
    .description("Compare a Verification report against a stored Baseline")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .requiredOption("--baseline <path>", "Baseline JSON path")
    .requiredOption("--report <path>", "Verification report.json path")
    .option("--journey-sha256 <sha256>", "Journey sha256 binding (defaults to the Baseline binding)")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: CompareOptions): Promise<void> => {
      const json = options.json === true;
      if (dependencies.baselineService === undefined) {
        writeFailure(
          dependencies,
          json,
          "CONFIG_INVALID",
          "TapHound regression comparison is not configured"
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
        const result = await dependencies.baselineService.compare({
          baselinePath: resolve(options.project, options.baseline),
          reportPath: resolve(options.project, options.report),
          journeySha256: options.journeySha256
        });
        if (json) {
          writeJson(dependencies.stdout, result);
        } else {
          writeLine(
            dependencies.stdout,
            result.equivalent
              ? `Regression compare: equivalent (${String(result.regressions.length)} diffs)`
              : `Regression compare: ${String(result.regressions.length)} diff(s)`
          );
          for (const diff of result.regressions) {
            writeLine(
              dependencies.stdout,
              `- ${diff.kind}${diff.stepIndex === undefined ? "" : ` step=${String(diff.stepIndex)}`}: expected ${diff.expected}, actual ${diff.actual}`
            );
          }
        }
        dependencies.setExitCode(result.equivalent ? 0 : 1);
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

