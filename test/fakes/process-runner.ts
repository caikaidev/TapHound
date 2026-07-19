import { vi } from "vitest";

import type {
  CommandResult,
  ProcessRunner,
  RunningCommand
} from "../../src/ports/process-runner.js";

export function commandResult(
  overrides: Partial<CommandResult> = {}
): CommandResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    ...overrides
  };
}

export function runningCommand(
  result: CommandResult = commandResult()
): RunningCommand {
  const completion = Promise.resolve(result);
  return {
    completion,
    stop: vi.fn(() => completion)
  };
}

export function processRunner(
  result: CommandResult = commandResult()
): ProcessRunner {
  return {
    run: vi.fn(() => Promise.resolve(result)),
    start: vi.fn(() => runningCommand(result))
  };
}
