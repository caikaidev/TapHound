import { resolve } from "node:path";

import { Command } from "commander";

import { TapHoundConfigSchema } from "../../domain/config.js";
import { assertArtifactDirectory } from "../../domain/workspace.js";
import {
  AlignError,
  type AlignCameraResult
} from "../../application/align/align-service.js";
import { AlignPromptCancelledError } from "../../ports/align-prompt.js";
import type { CliDependencies } from "../dependencies.js";
import {
  errorMessage,
  failureOutput,
  writeJson,
  writeLine
} from "../output.js";
import { assertNoLegacyWorkspace } from "../workspace-guard.js";

interface AlignCameraOptions {
  project: string;
  config: string;
  device?: string | undefined;
  force?: boolean | undefined;
  json?: boolean | undefined;
}

function alignCameraText(result: AlignCameraResult): string {
  if (result.status === "cancelled") {
    return "Cancelled — no flow written.";
  }
  const { flow, probe } = result;
  const confirmLine = probe.confirmResourceId !== undefined
    ? `  Confirm button:    ${probe.confirmResourceId}`
    : "  Confirm button:    (none — camera auto-accepts)";
  return [
    "Probing camera...",
    `  Camera package:    ${probe.packageName}`,
    `  Camera activity:   ${probe.activityName}`,
    `  Shutter button:    ${probe.shutterResourceId}`,
    confirmLine,
    "",
    `Wrote ${flow.name} flow (${String(flow.steps)} steps)`,
    `  Path: ${flow.path}`
  ].join("\n");
}

export function createAlignCommand(dependencies: CliDependencies): Command {
  const align = new Command("align")
    .description("Align device-specific External Flows");

  align
    .command("camera")
    .description("Probe the device camera and write a project External Flow")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", "taphound.config.json")
    .option("--device <serial>", "Select an online Android device")
    .option("--force", "Overwrite an existing project flow")
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: AlignCameraOptions): Promise<void> => {
      try {
        try {
          const config = await TapHoundConfigSchema.parseAsync(
            await dependencies.readJson(resolve(options.project, options.config))
          );
          assertArtifactDirectory(options.project, config.artifactsDir);
          await assertNoLegacyWorkspace(dependencies, options.project);
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

        const result = await dependencies.align.alignCamera({
          projectRoot: options.project,
          ...(options.device === undefined ? {} : { deviceSerial: options.device }),
          ...(options.force === undefined ? {} : { force: options.force }),
          json: options.json === true,
          ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal })
        });

        if (options.json === true) {
          writeJson(dependencies.stdout, result);
        } else {
          writeLine(dependencies.stdout, alignCameraText(result));
        }
        dependencies.setExitCode(result.exitCode);
      } catch (error) {
        if (error instanceof AlignPromptCancelledError) {
          const cancelled: AlignCameraResult = { status: "cancelled", exitCode: 2 };
          if (options.json === true) {
            writeJson(dependencies.stdout, cancelled);
          } else {
            writeLine(dependencies.stdout, alignCameraText(cancelled));
          }
          dependencies.setExitCode(2);
          return;
        }
        if (error instanceof AlignError) {
          const output = failureOutput(2, error.code, error.message);
          if (options.json === true) {
            writeJson(dependencies.stdout, output);
          } else {
            writeLine(dependencies.stderr, output.failure.message);
          }
          dependencies.setExitCode(2);
          return;
        }
        const output = failureOutput(4, "INTERNAL_ERROR", errorMessage(error));
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else {
          writeLine(dependencies.stderr, output.failure.message);
        }
        dependencies.setExitCode(4);
      }
    });

  return align;
}
