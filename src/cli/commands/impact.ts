import { Command } from "commander";

import { CONFIG_PATH } from "../../domain/workspace.js";
import type { ImpactSet } from "../../domain/impact.js";
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
  head: string;
  json?: boolean | undefined;
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

export function createImpactCommand(dependencies: CliDependencies): Command {
  return new Command("impact")
    .description("Compute which Knowledge and Journeys a Git change affects")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", CONFIG_PATH)
    .option("--base <ref>", "Base Git ref", "origin/main")
    .option("--head <ref>", "Head Git ref", "HEAD")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: ImpactOptions): Promise<void> => {
      try {
        if (
          dependencies.gitDiff === undefined
          || dependencies.impact === undefined
        ) {
          throw new Error("TapHound impact is not configured");
        }
        const changeSet = await dependencies.gitDiff.diff({
          projectRoot: options.project,
          base: options.base,
          head: options.head
        });
        const impact = await dependencies.impact.resolve(
          options.project,
          changeSet
        );
        if (options.json === true) {
          writeJson(dependencies.stdout, impact);
        } else {
          writeLine(dependencies.stdout, summarize(impact));
        }
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : String(error);
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