import type { DoctorReport } from "../application/doctor/doctor-service.js";
import type { ContextLoadError } from "../application/context/context-loader.js";
import type {
  FailureCode,
  TapHoundExitCode
} from "../domain/failure.js";
import type { TextOutput } from "./dependencies.js";

export interface CliFailureOutput {
  status: "error";
  exitCode: TapHoundExitCode;
  failure: {
    code: FailureCode;
    message: string;
  };
}

export function writeJson(output: TextOutput, value: unknown): void {
  output.write(`${JSON.stringify(value)}\n`);
}

export function writeLine(output: TextOutput, value: string): void {
  output.write(`${value}\n`);
}

export function failureOutput(
  exitCode: TapHoundExitCode,
  code: FailureCode,
  message: string
): CliFailureOutput {
  return {
    status: "error",
    exitCode,
    failure: { code, message }
  };
}

export function doctorMessage(report: DoctorReport): string {
  return report.checks.map((check) => {
    const detail = check.version ?? check.message;
    return `${check.status === "passed" ? "✓" : "✗"} ${check.name}${
      detail === undefined ? "" : `: ${detail}`
    }`;
  }).join("\n");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function contextLoadHint(error: ContextLoadError): string | undefined {
  if (
    error.code !== "CONTEXT_INVALID"
    || (!error.message.includes("index does not exist")
      && !error.message.includes("shard does not exist"))
  ) {
    return undefined;
  }
  return "Project Context is missing at the resolved path. Generate the "
    + "committed Context first with `taphound context generate`, or pass "
    + "--context with an explicit index path. For a registered local "
    + "target, run `taphound local sync <id>` before retrying. See "
    + "docs/agent-integration.md and docs/local-target.md.";
}
