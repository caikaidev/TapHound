import { resolve } from "node:path";

import { Command } from "commander";

import type { CliDependencies } from "../dependencies.js";
import {
  exitCodeForFailure,
  failureCodeFromUnknown,
  type FailureCode
} from "../../domain/failure.js";
import {
  ContractReviewInputSchema,
  ContractVerdictViewSchema
} from "../../domain/contract.js";
import {
  failureOutput,
  writeJson,
  writeLine
} from "../output.js";
import { assertNoLegacyWorkspace } from "../workspace-guard.js";

interface ContractOptions {
  project: string;
  contract?: string | undefined;
  json?: boolean | undefined;
}

interface ContractReviewOptions {
  verdict: string;
  findings: string;
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

export function createContractCommand(
  dependencies: CliDependencies
): Command {
  const command = new Command("contract")
    .description("Validate an Acceptance Contract without touching a device")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--contract <path>", "Acceptance Contract path")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: ContractOptions): Promise<void> => {
      const json = options.json === true;
      if (options.contract === undefined) {
        writeFailure(
          dependencies,
          json,
          "CONTRACT_INVALID",
          "Missing required option '--contract'"
        );
        return;
      }
      if (dependencies.contractLoader === undefined) {
        writeFailure(
          dependencies,
          json,
          "CONFIG_INVALID",
          "TapHound contract validation is not configured"
        );
        return;
      }
      const contractPath = resolve(options.project, options.contract);
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
        const loaded = await dependencies.contractLoader.load({
          projectRoot: options.project,
          contractPath
        });
        if (json) {
          writeJson(dependencies.stdout, {
            status: "valid",
            contractId: loaded.contract.id,
            contractSha256: loaded.contractSha256,
            journeySha256: loaded.contract.journey.sha256,
            journeyPath: loaded.journeyPath
          });
        } else {
          writeLine(
            dependencies.stdout,
            `TapHound contract: ${loaded.contract.id} is valid (${loaded.contractSha256.slice(0, 12)}...)`
          );
        }
        dependencies.setExitCode(0);
      } catch (error) {
        writeFailure(
          dependencies,
          json,
          failureCodeFromUnknown(error) ?? "CONTRACT_INVALID",
          error instanceof Error ? error.message : String(error)
        );
      }
    });
  command.addCommand(createContractReviewCommand(dependencies));
  return command;
}

function createContractReviewCommand(
  dependencies: CliDependencies
): Command {
  const command = new Command("review")
    .description("Merge reviewer findings into a Verdict (never overwrites fail/invalid)")
    .requiredOption("--verdict <path>", "Verdict JSON path (verdict.json)")
    .requiredOption("--findings <path>", "Reviewer findings JSON path")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: ContractReviewOptions): Promise<void> => {
      // `--project` and `--json` are also declared on the parent command;
      // commander routes them to the parent when both are declared, so fall
      // back to the parent's values.
      const parentOpts = command.parent?.opts() ?? {};
      const project = (parentOpts.project as string | undefined)
        ?? dependencies.cwd();
      const json = options.json === true
        || parentOpts.json === true;
      if (dependencies.contractReview === undefined) {
        writeFailure(
          dependencies,
          json,
          "CONFIG_INVALID",
          "TapHound contract review is not configured"
        );
        return;
      }
      const verdictPath = resolve(project, options.verdict);
      const findingsPath = resolve(project, options.findings);
      try {
        await assertNoLegacyWorkspace(dependencies, project);
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
        const verdict = ContractVerdictViewSchema.parse(
          await dependencies.readJson(verdictPath)
        );
        const review = ContractReviewInputSchema.parse(
          await dependencies.readJson(findingsPath)
        );
        const merged = await dependencies.contractReview.merge({
          view: verdict,
          review
        });
        await dependencies.contractReview.writeVerdict({
          verdictPath,
          view: merged.view
        });
        if (json) {
          writeJson(dependencies.stdout, merged.view);
        } else {
          writeLine(
            dependencies.stdout,
            `TapHound contract review: ${merged.view.verdict.toUpperCase()} (findings applied: ${String(merged.applied)})`
          );
        }
        dependencies.setExitCode(merged.view.verdict === "pass" ? 0 : 1);
      } catch (error) {
        writeFailure(
          dependencies,
          json,
          failureCodeFromUnknown(error) ?? "CONTRACT_INVALID",
          error instanceof Error ? error.message : String(error)
        );
      }
    });
  return command;
}