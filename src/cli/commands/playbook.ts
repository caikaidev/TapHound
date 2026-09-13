import { resolve } from "node:path";

import { Command } from "commander";

import type { CliDependencies } from "../dependencies.js";
import {
  PLAYBOOKS_DIR
} from "../../domain/workspace.js";
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

interface ValidateOptions {
  project: string;
  playbook?: string | undefined;
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

export function createPlaybookCommand(
  dependencies: CliDependencies
): Command {
  return new Command("playbook")
    .description("Validate Verification Playbooks without touching a device")
    .addCommand(createValidateCommand(dependencies));
}

function createValidateCommand(dependencies: CliDependencies): Command {
  return new Command("validate")
    .description("Validate Playbook schema, Contract hash binding, and Escalation Policy")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--playbook <path>", "Playbook JSON path(s), comma-separated")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: ValidateOptions): Promise<void> => {
      const json = options.json === true;
      if (dependencies.playbookValidator === undefined) {
        writeFailure(
          dependencies,
          json,
          "CONFIG_INVALID",
          "TapHound playbook validation is not configured"
        );
        return;
      }
      if (options.playbook === undefined) {
        writeFailure(
          dependencies,
          json,
          "CONFIG_INVALID",
          "Missing required option '--playbook'"
        );
        return;
      }
      const paths = options.playbook.split(",").map((path) => (
        resolve(options.project, path.trim())
      ));
      try {
        const output = await dependencies.playbookValidator.validate({
          projectRoot: options.project,
          playbookPaths: paths
        });
        if (json) {
          writeJson(dependencies.stdout, output);
        } else {
          for (const playbook of output.playbooks) {
            writeLine(
              dependencies.stdout,
              `${playbook.ok ? "ok" : "invalid"}\t${playbook.id}${
                playbook.issues.length === 0
                  ? ""
                  : `\n  - ${playbook.issues.join("\n  - ")}`
              }`
            );
          }
        }
        dependencies.setExitCode(output.status === "valid" ? 0 : 2);
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

export { PLAYBOOKS_DIR };