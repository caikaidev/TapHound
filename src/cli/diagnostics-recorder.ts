import { arch, platform, version as nodeVersion } from "node:process";
import { resolve } from "node:path";

import type { Command } from "commander";

import {
  CommandEventSchema,
  DIAGNOSTICS_DISABLE_ENV_VAR,
  type CommandEvent,
  type DiagnosticsHostSchema
} from "../domain/diagnostics.js";
import { FAILURE_CODES, type FailureCode } from "../domain/failure.js";
import type { UiCaptureTelemetry } from "../application/diagnostics/ui-capture-telemetry.js";
import type { DiagnosticsJournal } from "../ports/diagnostics.js";
import type { z } from "zod";
import { readCliVersion } from "./version.js";

export interface CliDiagnostics {
  journal: DiagnosticsJournal;
  telemetry: UiCaptureTelemetry;
}

export function diagnosticsEnabled(env: Record<string, string | undefined>): boolean {
  const value = env[DIAGNOSTICS_DISABLE_ENV_VAR]?.trim().toLowerCase();
  return !["0", "off", "false", "no"].includes(value ?? "");
}

export function diagnosticsHost(): z.infer<typeof DiagnosticsHostSchema> {
  return {
    platform,
    arch,
    node: nodeVersion.replace(/^v/, "")
  };
}

/** What the invoked command is, captured before its action runs. */
export interface InvokedCommand {
  command: string;
  flags: string[];
  projectRoot: string;
}

export function describeInvocation(action: Command, cwd: string): InvokedCommand {
  const names: string[] = [];
  let command: Command = action;
  while (command.parent !== null) {
    names.unshift(command.name());
    command = command.parent;
  }
  const flags = action.options
    .map((option) => option.attributeName())
    .filter((name) => action.getOptionValueSource(name) === "cli");
  const project = action.opts<{ project?: unknown }>().project;
  return {
    command: names.join(" "),
    flags,
    projectRoot: typeof project === "string" ? resolve(cwd, project) : cwd
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function failureCode(value: unknown): FailureCode | undefined {
  return FAILURE_CODES.find((code) => code === value);
}

/**
 * Reads only the structured outcome of one machine-readable output: status,
 * failure code, and run id. Messages and every other field are ignored.
 */
export function outcomeFromJsonOutput(stdout: string): Pick<CommandEvent, "status" | "failureCode" | "runId"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return {};
  }
  const output = record(parsed);
  if (output === undefined) return {};
  const report = record(output.report);
  const status = [output.status, output.verdict].find((value) => (
    typeof value === "string" && /^[a-zA-Z][a-zA-Z\d]{0,31}$/.test(value)
  ));
  const code = failureCode(record(output.failure)?.code)
    ?? failureCode(record(report?.primaryFailure)?.code);
  const runId = [report?.runId, output.runId].find((value) => (
    typeof value === "string" && /^[\w.-]{1,128}$/.test(value)
  ));
  return {
    ...(typeof status === "string" ? { status } : {}),
    ...(code === undefined ? {} : { failureCode: code }),
    ...(typeof runId === "string" ? { runId } : {})
  };
}

export function commandEvent(input: {
  invocation: InvokedCommand;
  startedAt: Date;
  durationMs: number;
  exitCode: number;
  stdout: string | undefined;
  telemetry: UiCaptureTelemetry;
}): CommandEvent {
  return CommandEventSchema.parse({
    version: 1,
    kind: "command",
    at: input.startedAt.toISOString(),
    taphoundVersion: readCliVersion(),
    host: diagnosticsHost(),
    command: input.invocation.command,
    flags: input.invocation.flags,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    exitCode: input.exitCode,
    ...(input.stdout === undefined ? {} : outcomeFromJsonOutput(input.stdout)),
    ui: input.telemetry.summary()
  });
}
