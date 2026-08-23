import { extname } from "node:path";

import { Command } from "commander";
import { z } from "zod";

import {
  JourneyCompositionError
} from "../../application/journey/journey-resolver.js";
import {
  JourneyResolutionManifestSchema,
  ResolvedJourneyPathSchema
} from "../../domain/journey-composition.js";
import { JourneySchema } from "../../domain/journey.js";
import type { CliDependencies } from "../dependencies.js";
import {
  errorMessage,
  writeJson,
  writeLine
} from "../output.js";
import { assertNoLegacyWorkspace } from "../workspace-guard.js";

interface JourneyResolveOptions {
  project: string;
  source: string;
  output: string;
  json?: boolean | undefined;
}

interface JourneyListOptions {
  project: string;
  json?: boolean | undefined;
  includeExternal?: boolean | undefined;
}

function manifestPath(outputPath: string): string {
  const extension = extname(outputPath);
  return extension.toLowerCase() === ".json"
    ? `${outputPath.slice(0, -extension.length)}.resolve.json`
    : `${outputPath}.resolve.json`;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requireComposition(
  dependencies: CliDependencies
): {
  resolver: NonNullable<CliDependencies["journeyResolver"]>;
  store: NonNullable<CliDependencies["journeyCompositionStore"]>;
} {
  if (
    dependencies.journeyResolver === undefined
    || dependencies.journeyCompositionStore === undefined
  ) {
    throw new Error("Journey composition runtime is unavailable");
  }
  return {
    resolver: dependencies.journeyResolver,
    store: dependencies.journeyCompositionStore
  };
}

function writeFailure(
  dependencies: CliDependencies,
  options: { json?: boolean | undefined },
  error: unknown
): void {
  const known = error instanceof JourneyCompositionError
    || error instanceof z.ZodError;
  const output = {
    status: "error" as const,
    exitCode: known ? 2 as const : 4 as const,
    failure: {
      code: error instanceof JourneyCompositionError
        ? error.code
        : error instanceof z.ZodError
          ? "CONFIG_INVALID"
          : "INTERNAL_ERROR",
      message: errorMessage(error)
    }
  };
  if (options.json === true) {
    writeJson(dependencies.stdout, output);
  } else {
    writeLine(dependencies.stderr, output.failure.message);
  }
  dependencies.setExitCode(output.exitCode);
}

function createResolveCommand(dependencies: CliDependencies): Command {
  return new Command("resolve")
    .description("Resolve a composed Journey source into Journey v1")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .requiredOption("--source <path>", "Project-relative Journey source path")
    .requiredOption("--output <path>", "Project-relative Journey v1 output path")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: JourneyResolveOptions): Promise<void> => {
      try {
        await assertNoLegacyWorkspace(dependencies, options.project);
        const composition = requireComposition(dependencies);
        const resolution = await composition.resolver.resolve({
          projectRoot: options.project,
          sourcePath: options.source
        });
        const journey = JourneySchema.parse(resolution.journey);
        const manifest = JourneyResolutionManifestSchema.parse(
          resolution.manifest
        );
        const journeyPath = ResolvedJourneyPathSchema.parse(options.output);
        const sidecarPath = manifestPath(journeyPath);
        await composition.store.writeText({
          projectRoot: options.project,
          relativePath: journeyPath,
          content: serialize(journey)
        });
        await composition.store.writeText({
          projectRoot: options.project,
          relativePath: sidecarPath,
          content: serialize(manifest)
        });
        const output = {
          status: "resolved" as const,
          exitCode: 0 as const,
          journeyPath,
          manifestPath: sidecarPath,
          journeySha256: manifest.journey.sha256,
          resolutionSha256: manifest.resolutionSha256,
          stepCount: journey.steps.length,
          flows: manifest.expansion
        };
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else {
          writeLine(
            dependencies.stdout,
            `Resolved ${journey.name}: ${journeyPath}`
          );
        }
        dependencies.setExitCode(0);
      } catch (error) {
        writeFailure(dependencies, options, error);
      }
    });
}

function createListFlowsCommand(dependencies: CliDependencies): Command {
  return new Command("list-flows")
    .description("List and validate reusable local Flows")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--json", "Emit one machine-readable JSON value")
    .option("--include-external", "Also list External Flows")
    .action(async (options: JourneyListOptions): Promise<void> => {
      try {
        await assertNoLegacyWorkspace(dependencies, options.project);
        const entries = await requireComposition(
          dependencies
        ).resolver.listFlows(options.project);
        const output: {
          status: "listed";
          exitCode: 0;
          flows: typeof entries;
          externalFlows?: unknown[];
        } = {
          status: "listed",
          exitCode: 0,
          flows: entries
        };
        if (options.includeExternal === true) {
          if (dependencies.externalFlowResolver === undefined) {
            throw new Error("External Flow resolver is unavailable");
          }
          const externalEntries = await dependencies.externalFlowResolver.list(
            options.project
          );
          output.externalFlows = [...externalEntries];
        }
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else if (
          entries.length === 0
          && output.externalFlows === undefined
        ) {
          writeLine(dependencies.stdout, "No reusable Flows found");
        } else {
          const lines: string[] = entries.map(
            (entry) => `${entry.name}: ${entry.status}`
          );
          if (output.externalFlows !== undefined) {
            if (output.externalFlows.length === 0) {
              lines.push("No External Flows found");
            } else {
              for (const entry of output.externalFlows) {
                const external = entry as {
                  name: string;
                  source: string;
                  status: string;
                };
                lines.push(
                  `${external.name}: ${external.status} (external, ${external.source})`
                );
              }
            }
          }
          writeLine(dependencies.stdout, lines.join("\n"));
        }
        dependencies.setExitCode(0);
      } catch (error) {
        writeFailure(dependencies, options, error);
      }
    });
}

export function createJourneyCommand(dependencies: CliDependencies): Command {
  return new Command("journey")
    .description("Compose reusable Flows into runnable Journeys")
    .addCommand(createResolveCommand(dependencies))
    .addCommand(createListFlowsCommand(dependencies));
}
