import { resolve } from "node:path";

import { Command, InvalidArgumentError } from "commander";

import type { CliDependencies } from "../dependencies.js";
import { exitCodeForFailure, failureCodeFromUnknown } from "../../domain/failure.js";
import { DIAGNOSTICS_EXPORT_DIR } from "../../domain/workspace.js";
import {
  errorMessage,
  failureOutput,
  writeJson,
  writeLine
} from "../output.js";

interface ExportOptions {
  project: string;
  out?: string | undefined;
  events: number;
  runs: number;
  json?: boolean | undefined;
}

const REVIEW_NOTE = "Review the file before sharing it. It holds command outcomes, "
  + "timings, and failure codes; project paths, package, Activity and Journey "
  + "names, locator values, device serials, screenshots, UI hierarchies, and "
  + "log text are left out or replaced by aliases.";

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw new InvalidArgumentError("must be an integer from 1 to 1000");
  }
  return parsed;
}

function exportFileName(at: Date): string {
  return `taphound-diagnostics-${at.toISOString().replaceAll(":", "-")}.json`;
}

export function createDiagnoseCommand(dependencies: CliDependencies): Command {
  return new Command("diagnose")
    .description("Collect redacted diagnostics to attach to TapHound feedback")
    .addCommand(new Command("export")
      .description("Write a redacted diagnostics bundle from the local journal and recent reports")
      .option("--project <path>", "Android project root", dependencies.cwd())
      .option("--out <path>", `Bundle path (default ${DIAGNOSTICS_EXPORT_DIR}/<timestamp>.json)`)
      .option("--events <count>", "Most recent journal events to include", positiveInteger, 50)
      .option("--runs <count>", "Most recent referenced runs to summarize", positiveInteger, 10)
      .option("--json", "Emit one machine-readable JSON value")
      .action(async (options: ExportOptions): Promise<void> => {
        const json = options.json === true;
        const diagnostics = dependencies.diagnosticsExport;
        if (diagnostics === undefined) {
          const output = failureOutput(2, "CONFIG_INVALID", "TapHound diagnostics export is not configured");
          if (json) {
            writeJson(dependencies.stdout, output);
          } else {
            writeLine(dependencies.stderr, output.failure.message);
          }
          dependencies.setExitCode(2);
          return;
        }
        try {
          const projectRoot = resolve(dependencies.cwd(), options.project);
          const bundle = await diagnostics.export({
            projectRoot,
            eventLimit: options.events,
            runLimit: options.runs
          });
          const path = options.out === undefined
            ? resolve(projectRoot, DIAGNOSTICS_EXPORT_DIR, exportFileName(new Date(bundle.generatedAt)))
            : resolve(dependencies.cwd(), options.out);
          await diagnostics.write(path, `${JSON.stringify(bundle, null, 2)}\n`);
          if (json) {
            writeJson(dependencies.stdout, {
              status: "exported",
              exitCode: 0,
              path,
              events: bundle.journal.events.length,
              runs: bundle.runs.length
            });
          } else {
            writeLine(
              dependencies.stdout,
              `TapHound diagnostics: ${path}\n${String(bundle.journal.events.length)} event(s), `
                + `${String(bundle.runs.length)} run summary(ies)`
            );
          }
          writeLine(dependencies.stderr, REVIEW_NOTE);
          dependencies.setExitCode(0);
        } catch (error) {
          const code = failureCodeFromUnknown(error) ?? "INTERNAL_ERROR";
          const exitCode = exitCodeForFailure(code);
          const output = failureOutput(exitCode, code, errorMessage(error));
          if (json) {
            writeJson(dependencies.stdout, output);
          } else {
            writeLine(dependencies.stderr, output.failure.message);
          }
          dependencies.setExitCode(exitCode);
        }
      }));
}
