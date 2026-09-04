import { Command } from "commander";

import type { CliDependencies } from "../dependencies.js";
import { errorMessage, writeJson, writeLine } from "../output.js";

interface CacheOptions {
  project: string;
  json?: boolean | undefined;
}

interface ClearCacheOptions extends CacheOptions {
  yes?: boolean | undefined;
}

function cache(dependencies: CliDependencies): NonNullable<CliDependencies["uiCache"]> {
  if (dependencies.uiCache === undefined) {
    throw new Error("UI cache management is unavailable in this runtime");
  }
  return dependencies.uiCache;
}

function writeResult(
  dependencies: CliDependencies,
  options: CacheOptions,
  value: unknown,
  text: string,
  code = 0
): void {
  if (options.json === true) {
    writeJson(dependencies.stdout, value);
  } else {
    writeLine(code === 0 ? dependencies.stdout : dependencies.stderr, text);
  }
  dependencies.setExitCode(code);
}

export function createUiCacheCommand(dependencies: CliDependencies): Command {
  const status = new Command("status")
    .description("Show the non-authoritative UI cache size")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: CacheOptions): Promise<void> => {
      try {
        const report = await cache(dependencies).status(options.project);
        writeResult(
          dependencies,
          options,
          { status: "ok", cache: report },
          `UI cache: ${String(report.entries)} entries, ${String(report.bytes)} bytes`
        );
      } catch (error) {
        writeResult(
          dependencies,
          options,
          { status: "error", message: errorMessage(error) },
          errorMessage(error),
          4
        );
      }
    });
  const clear = new Command("clear")
    .description("Delete only the rebuildable UI cache")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .requiredOption("--yes", "Confirm deletion of the UI cache")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: ClearCacheOptions): Promise<void> => {
      try {
        await cache(dependencies).clear(options.project);
        writeResult(
          dependencies,
          options,
          { status: "cleared" },
          "UI cache cleared"
        );
      } catch (error) {
        writeResult(
          dependencies,
          options,
          { status: "error", message: errorMessage(error) },
          errorMessage(error),
          4
        );
      }
    });
  return new Command("ui-cache")
    .description("Inspect or clear rebuildable UI cache indexes")
    .addCommand(status)
    .addCommand(clear);
}
