import { resolve } from "node:path";

import { Command } from "commander";

import { CONFIG_PATH } from "../../domain/workspace.js";
import type { ImpactSet } from "../../domain/impact.js";
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
import type { CliDependencies } from "../dependencies.js";

interface ImpactOptions {
  project: string;
  config: string;
  base: string;
  head?: string | undefined;
  target?: string | undefined;
  targets?: string | undefined;
  json?: boolean | undefined;
}

function targetsHome(
  dependencies: CliDependencies,
  explicit: string | undefined
): string {
  if (explicit !== undefined) {
    return resolve(dependencies.cwd(), explicit);
  }
  return dependencies.localTargets.targetsHome();
}

function summarize(impact: ImpactSet): string {
  const lines = [
    `TapHound impact: ${impact.base}...${impact.head}`,
    `affected modules: ${impact.affectedModules.join(", ") || "(none)"}`,
    `affected features: ${impact.affectedFeatures.join(", ") || "(none)"}`,
    `affected screens: ${impact.affectedScreens.join(", ") || "(none)"}`,
    `affected anchors: ${impact.affectedAnchors.join(", ") || "(none)"}`,
    `affected transitions: ${impact.affectedTransitions.join(", ") || "(none)"}`,
    "[P0]",
    ...impact.selectedJourneys.p0.map((entry) => `  ${entry.id} — ${entry.reason}`),
    "[P1]",
    ...impact.selectedJourneys.p1.map((entry) => `  ${entry.id} — ${entry.reason}`),
    "[P2]",
    ...impact.selectedJourneys.p2.map((entry) => `  ${entry.id} — ${entry.reason}`),
    "skipped",
    ...impact.skippedJourneys.map((entry) => `  ${entry.id} — ${entry.reason}`)
  ];
  return lines.join("\n");
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

export function createImpactCommand(dependencies: CliDependencies): Command {
  return new Command("impact")
    .description("Compute which Knowledge and Journeys a Git change affects")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", CONFIG_PATH)
    .option("--base <ref>", "Base Git ref", "origin/main")
    .option("--head <ref>", "Head Git ref (defaults to HEAD, or WORKTREE with --target)")
    .option("--target <id>", "Registered local target id")
    .option("--targets <path>", "Targets workspace base path")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: ImpactOptions): Promise<void> => {
      try {
        if (
          dependencies.gitDiff === undefined
          || dependencies.impact === undefined
        ) {
          throw new Error("TapHound impact is not configured");
        }
        const head = options.head
          ?? (options.target === undefined ? "HEAD" : "WORKTREE");

        let changeSet;
        let impact;
        if (options.target !== undefined) {
          const id = options.target;
          const home = targetsHome(dependencies, options.targets);
          const resolved = await dependencies.localTargets
            .targetResolver(home).resolve(id);
          const gitRoot = resolved.project.gitRoot ?? resolved.resolvedPath;
          changeSet = await dependencies.gitDiff.diff({
            projectRoot: gitRoot,
            base: options.base,
            head
          });
          impact = await dependencies.impact.resolve({
            projectRoot: resolved.resolvedPath,
            workspaceRoot: resolved.workspaceRoot,
            changeSet
          });
        } else {
          changeSet = await dependencies.gitDiff.diff({
            projectRoot: options.project,
            base: options.base,
            head
          });
          impact = await dependencies.impact.resolve({
            projectRoot: options.project,
            changeSet
          });
        }
        if (options.json === true) {
          writeJson(dependencies.stdout, impact);
        } else {
          writeLine(dependencies.stdout, summarize(impact));
        }
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : String(error);
        const code = failureCodeFromUnknown(error);
        if (code !== undefined) {
          writeFailure(dependencies, options.json === true, code, message);
          return;
        }
        const output = failureOutput(2, "CONFIG_INVALID", message);
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else {
          writeLine(dependencies.stderr, output.failure.message);
        }
        dependencies.setExitCode(2);
      }
    });
}