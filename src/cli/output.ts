import type { DoctorReport } from "../application/doctor/doctor-service.js";
import type { FailureCode } from "../domain/failure.js";
import type { TextOutput } from "./dependencies.js";

export interface CliFailureOutput {
  status: "error";
  exitCode: 2 | 3 | 4;
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
  exitCode: 2 | 3 | 4,
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
