#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CommanderError, type Command } from "commander";

import {
  createProductionDependencies,
  type CliDependencies
} from "./dependencies.js";
import {
  RuntimeBackendConfigError,
  RuntimeBackendSelectionError,
  resolveRuntimeBackendChoiceFromInvocation
} from "./runtime-selection.js";
import { errorMessage, failureOutput, writeJson, writeLine } from "./output.js";
import { createProgram } from "./program.js";

interface CommanderFailure {
  exitCode: number;
}

export interface TerminationSignalSource {
  once: (event: "SIGINT" | "SIGTERM", listener: () => void) => unknown;
  off: (event: "SIGINT" | "SIGTERM", listener: () => void) => unknown;
}

export async function withTerminationSignal<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  source: TerminationSignalSource = process
): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort(new Error("TapHound was interrupted"));
  };
  source.once("SIGINT", abort);
  source.once("SIGTERM", abort);
  try {
    return await operation(controller.signal);
  } finally {
    source.off("SIGINT", abort);
    source.off("SIGTERM", abort);
  }
}

function asCommanderFailure(error: unknown): CommanderFailure | undefined {
  if (error instanceof CommanderError) {
    return error;
  }
  if (error === null || typeof error !== "object") {
    return undefined;
  }
  const candidate = error as Record<string, unknown>;
  return typeof candidate.exitCode === "number"
    && typeof candidate.code === "string"
    && candidate.code.startsWith("commander.")
    ? { exitCode: candidate.exitCode }
    : undefined;
}

function overrideCommandExits(command: Command): void {
  command.exitOverride();
  for (const child of command.commands) {
    overrideCommandExits(child);
  }
}

export async function runMain(
  argv: readonly string[],
  dependencies: CliDependencies = createProductionDependencies()
): Promise<void> {
  const json = argv.includes("--json");
  try {
    const program = createProgram(dependencies);
    overrideCommandExits(program);
    await program.parseAsync([...argv]);
  } catch (error) {
    const commander = asCommanderFailure(error);
    if (commander?.exitCode === 0) {
      dependencies.setExitCode(0);
      return;
    }
    const commanderFailure = commander !== undefined;
    const exitCode: 2 | 4 = commanderFailure ? 2 : 4;
    const output = failureOutput(
      exitCode,
      commanderFailure ? "CONFIG_INVALID" : "INTERNAL_ERROR",
      errorMessage(error)
    );
    if (json) {
      writeJson(dependencies.stdout, output);
    } else {
      writeLine(dependencies.stderr, output.failure.message);
    }
    dependencies.setExitCode(exitCode);
  }
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined
  && import.meta.url === pathToFileURL(realpathSync(resolve(entryPath))).href
) {
  await withTerminationSignal(async (signal) => {
    let dependencies: CliDependencies;
    try {
      dependencies = createProductionDependencies(signal, {
        runtimeBackendChoice: await resolveRuntimeBackendChoiceFromInvocation({
          env: process.env,
          argv: process.argv,
          cwd: process.cwd(),
          readConfigFile: (path): Promise<string> => readFile(path, "utf8")
        })
      });
    } catch (error) {
      if (
        error instanceof RuntimeBackendSelectionError
        || error instanceof RuntimeBackendConfigError
      ) {
        const output = failureOutput(2, "CONFIG_INVALID", error.message);
        if (process.argv.includes("--json")) {
          writeJson(
            {
              write: (content): void => {
                process.stdout.write(content);
              }
            },
            output
          );
        } else {
          writeLine(
            {
              write: (content): void => {
                process.stderr.write(content);
              }
            },
            output.failure.message
          );
        }
        process.exitCode = 2;
        return;
      }
      throw error;
    }
    try {
      await runMain(process.argv, dependencies);
    } finally {
      try {
        await dependencies.close?.();
      } catch (error) {
        process.stderr.write(
          `TapHound: failed to release the runtime backend: ${
            errorMessage(error)
          }\n`
        );
      }
    }
  });
}
