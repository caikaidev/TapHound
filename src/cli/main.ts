#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CommanderError } from "commander";

import {
  createProductionDependencies,
  type CliDependencies
} from "./dependencies.js";
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
    controller.abort(new Error("APR was interrupted"));
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

export async function runMain(
  argv: readonly string[],
  dependencies: CliDependencies = createProductionDependencies()
): Promise<void> {
  const json = argv.includes("--json");
  try {
    const program = createProgram(dependencies).exitOverride();
    for (const command of program.commands) {
      command.exitOverride();
    }
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
  && import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
  await withTerminationSignal((signal) => runMain(
    process.argv,
    createProductionDependencies(signal)
  ));
}
