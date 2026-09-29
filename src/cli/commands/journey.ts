import { extname, resolve } from "node:path";

import { Command } from "commander";
import { z } from "zod";

import {
  JourneyCheckError,
  JourneyCheckService,
  type JourneyCheckEntry
} from "../../application/journey/journey-check-service.js";
import {
  JourneyPromotionError,
  JourneyPromoter
} from "../../application/journey/journey-promoter.js";
import {
  JourneyRetireError,
  JourneyRetirer
} from "../../application/journey/journey-retirer.js";
import {
  JourneyCompositionError
} from "../../application/journey/journey-resolver.js";
import {
  ContextLoadError
} from "../../application/context/context-loader.js";
import { TapHoundConfigSchema } from "../../domain/config.js";
import type { TapHoundConfig } from "../../domain/config.js";
import type { JourneyLifecycleState } from "../../domain/journey-lifecycle.js";
import {
  JourneyResolutionManifestSchema,
  ResolvedJourneyPathSchema
} from "../../domain/journey-composition.js";
import { JourneySchema } from "../../domain/journey.js";
import {
  assertArtifactDirectory,
  CONFIG_PATH,
  CONTEXT_INDEX_PATH
} from "../../domain/workspace.js";
import type { CliDependencies } from "../dependencies.js";
import {
  contextLoadHint,
  errorMessage,
  writeJson,
  writeLine
} from "../output.js";
import { prepareWorkspace } from "../workspace-guard.js";
import { canonicalProjectRoot } from "../project-root.js";

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

interface JourneyCheckOptions {
  project: string;
  config: string;
  context?: string | undefined;
  journey?: string[] | undefined;
  json?: boolean | undefined;
  strict?: boolean | undefined;
}

interface JourneyPromoteOptions {
  project: string;
  journey: string;
  reason: string;
  json?: boolean | undefined;
}

interface JourneyRetireOptions {
  project: string;
  journey: string;
  reason: string;
  json?: boolean | undefined;
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
    || error instanceof JourneyCheckError
    || error instanceof JourneyPromotionError
    || error instanceof JourneyRetireError
    || error instanceof ContextLoadError
    || error instanceof z.ZodError;
  const hint = error instanceof ContextLoadError
    ? contextLoadHint(error)
    : undefined;
  const output = {
    status: "error" as const,
    exitCode: known ? 2 as const : 4 as const,
    failure: {
      code: error instanceof JourneyCompositionError
        ? error.code
        : error instanceof JourneyCheckError
          ? error.code
          : error instanceof JourneyPromotionError
            ? error.code
            : error instanceof JourneyRetireError
              ? error.code
              : error instanceof ContextLoadError
                ? error.code
                : error instanceof z.ZodError
                  ? "CONFIG_INVALID"
                  : "INTERNAL_ERROR",
      message: errorMessage(error),
      ...(hint === undefined ? {} : { hint })
    }
  };
  if (options.json === true) {
    writeJson(dependencies.stdout, output);
  } else {
    writeLine(dependencies.stderr, output.failure.message);
  }
  dependencies.setExitCode(output.exitCode);
}

function lifecycleSummary(
  entries: readonly JourneyCheckEntry[]
): Record<JourneyLifecycleState, number> {
  const counts: Record<JourneyLifecycleState, number> = {
    draft: 0,
    verified: 0,
    promoted: 0,
    suspect: 0,
    stale: 0,
    retired: 0
  };
  for (const entry of entries) {
    if (entry.lifecycle !== undefined) {
      counts[entry.lifecycle] += 1;
    }
  }
  return counts;
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
        await prepareWorkspace(dependencies, options.project);
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
        await prepareWorkspace(dependencies, options.project);
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

function checkEntryLine(entry: JourneyCheckEntry): string {
  if (entry.reasons.length === 0) {
    return `${entry.name}: ${entry.status}`;
  }
  const detail = entry.reasons.map((reason) => {
    if (reason === "module-drift" || reason === "module-missing") {
      const ids = entry.driftedModules
        .filter((module) => (
          reason === "module-drift"
            ? module.reason === "sha256"
            : module.reason === "missing"
        ))
        .map((module) => module.id);
      return `${reason}: ${ids.join(", ")}`;
    }
    return reason;
  });
  return `${entry.name}: ${entry.status} (${detail.join(", ")})`;
}

function createCheckCommand(dependencies: CliDependencies): Command {
  return new Command("check")
    .description("Check committed Journeys against live project bindings")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", CONFIG_PATH)
    .option("--context <path>", "Project Context index path")
    .option(
      "--journey <path-or-name...>",
      "Check only these Journeys (project-relative path or Journey name)"
    )
    .option("--json", "Emit one machine-readable JSON value")
    .option("--strict", "Exit non-zero when any Journey is not fresh")
    .action(async (options: JourneyCheckOptions): Promise<void> => {
      try {
        const projectRoot = await canonicalProjectRoot(
          dependencies.cwd(),
          options.project
        );
        await prepareWorkspace(dependencies, projectRoot);
        const composition = requireComposition(dependencies);
        let config: TapHoundConfig;
        try {
          config = TapHoundConfigSchema.parse(
            await dependencies.readJson(resolve(projectRoot, options.config))
          );
          assertArtifactDirectory(projectRoot, config.artifactsDir);
        } catch (error) {
          throw new JourneyCheckError(
            "CONFIG_INVALID",
            error instanceof Error ? error.message : String(error),
            { cause: error }
          );
        }
        const index = await dependencies.contextLoader.readIndex({
          projectRoot,
          contextPath: resolve(
            projectRoot,
            options.context ?? CONTEXT_INDEX_PATH
          )
        });
        const project = await dependencies.projectDescriber.describe({
          projectRoot,
          config,
          ...(dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal })
        });
        const result = await new JourneyCheckService({
          store: composition.store
        }).check({
          projectRoot,
          config,
          project,
          bundle: index.bundle,
          journeys: options.journey
        });
        const notFresh = result.summary.total - result.summary.fresh;
        const exitCode = options.strict === true && notFresh > 0 ? 1 : 0;
        const lifecycleCounts = lifecycleSummary(result.entries);
        const output = {
          status: "checked" as const,
          exitCode,
          strict: options.strict === true,
          summary: result.summary,
          lifecycle: lifecycleCounts,
          journeys: result.entries
        };
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else if (result.entries.length === 0) {
          writeLine(dependencies.stdout, "No Journeys found");
        } else {
          const lines = result.entries.map(checkEntryLine);
          for (const entry of result.entries) {
            if (entry.status === "invalid" && entry.message !== undefined) {
              lines.push(`  ${entry.message}`);
            }
          }
          lines.push(
            `Checked ${String(result.summary.total)} Journeys: `
            + `${String(result.summary.fresh)} fresh, `
            + `${String(result.summary.stale)} stale, `
            + `${String(result.summary.noMeta)} no-meta, `
            + `${String(result.summary.invalid)} invalid`
          );
          lines.push(
            `Lifecycle: `
            + Object.entries(lifecycleCounts)
              .filter(([, count]) => count > 0)
              .map(([state, count]) => `${state} ${String(count)}`)
              .join(", ")
          );
          writeLine(dependencies.stdout, lines.join("\n"));
        }
        dependencies.setExitCode(exitCode);
      } catch (error) {
        writeFailure(dependencies, options, error);
      }
    });
}

function createPromoteCommand(dependencies: CliDependencies): Command {
  return new Command("promote")
    .description("Promote a replay-verified Journey into a durable asset")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .requiredOption("--journey <path>", "Project-relative Journey path")
    .requiredOption("--reason <text>", "Why this Journey is worth keeping")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: JourneyPromoteOptions): Promise<void> => {
      try {
        const projectRoot = options.project;
        await prepareWorkspace(dependencies, projectRoot);
        const composition = requireComposition(dependencies);
        const result = await new JourneyPromoter({
          store: composition.store
        }).promote({
          projectRoot,
          journeyPath: options.journey,
          reason: options.reason,
          now: new Date()
        });
        const output = {
          status: "promoted" as const,
          exitCode: 0 as const,
          journeyPath: result.journeyPath,
          metaPath: result.metaPath,
          generationId: result.generationId,
          promotedAt: result.promotedAt
        };
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else {
          writeLine(
            dependencies.stdout,
            `Promoted ${result.journeyPath} (${result.generationId})`
          );
        }
        dependencies.setExitCode(0);
      } catch (error) {
        writeFailure(dependencies, options, error);
      }
    });
}

function createRetireCommand(dependencies: CliDependencies): Command {
  return new Command("retire")
    .description("Retire a Journey; its replay can no longer be trusted")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .requiredOption("--journey <path>", "Project-relative Journey path")
    .requiredOption("--reason <text>", "Why this Journey is retired")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: JourneyRetireOptions): Promise<void> => {
      try {
        const projectRoot = options.project;
        await prepareWorkspace(dependencies, projectRoot);
        const composition = requireComposition(dependencies);
        const result = await new JourneyRetirer({
          store: composition.store
        }).retire({
          projectRoot,
          journeyPath: options.journey,
          reason: options.reason,
          now: new Date()
        });
        const output = {
          status: "retired" as const,
          exitCode: 0 as const,
          journeyPath: result.journeyPath,
          metaPath: result.metaPath,
          retiredAt: result.retiredAt
        };
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else {
          writeLine(
            dependencies.stdout,
            `Retired ${result.journeyPath}`
          );
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
    .addCommand(createListFlowsCommand(dependencies))
    .addCommand(createCheckCommand(dependencies))
    .addCommand(createPromoteCommand(dependencies))
    .addCommand(createRetireCommand(dependencies));
}
