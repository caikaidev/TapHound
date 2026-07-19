import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import type {
  CommandResult,
  CommandSpec,
  ProcessRunner,
  RunningCommand,
  StreamHandlers
} from "../../ports/process-runner.js";

interface LineBuffer {
  pending: string;
  emit?: ((line: string) => void) | undefined;
}

function consumeLines(buffer: LineBuffer, chunk: string): void {
  const content = buffer.pending + chunk;
  const lines = content.split(/\r?\n/);
  buffer.pending = lines.pop() ?? "";
  for (const line of lines) {
    buffer.emit?.(line);
  }
}

function flushLine(buffer: LineBuffer): void {
  if (buffer.pending.length > 0) {
    buffer.emit?.(buffer.pending);
    buffer.pending = "";
  }
}

export class NodeProcessRunner implements ProcessRunner {
  public constructor(private readonly defaultTimeoutMs = 15 * 60 * 1000) {}

  public run(spec: CommandSpec): Promise<CommandResult> {
    return this.start({
      ...spec,
      timeoutMs: spec.timeoutMs ?? this.defaultTimeoutMs
    }).completion;
  }

  public start(
    spec: CommandSpec,
    handlers: StreamHandlers = {}
  ): RunningCommand {
    const startedAt = performance.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let spawnError: string | undefined;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;

    const stdoutLines: LineBuffer = {
      pending: "",
      emit: handlers.onStdoutLine === undefined
        ? undefined
        : (line): void => handlers.onStdoutLine?.(line)
    };
    const stderrLines: LineBuffer = {
      pending: "",
      emit: handlers.onStderrLine === undefined
        ? undefined
        : (line): void => handlers.onStderrLine?.(line)
    };

    const child = spawn(spec.executable, [...spec.args], {
      cwd: spec.cwd,
      env: {
        ...process.env,
        ...spec.env
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      consumeLines(stdoutLines, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      consumeLines(stderrLines, chunk);
    });
    child.on("error", (error) => {
      spawnError = error.message;
    });

    const terminate = (): void => {
      if (settled || child.killed) {
        return;
      }
      child.kill("SIGTERM");
      forceKillTimeout = setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 1000);
      forceKillTimeout.unref();
    };

    const abort = (): void => {
      cancelled = true;
      terminate();
    };
    spec.signal?.addEventListener("abort", abort, { once: true });

    if (spec.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, spec.timeoutMs);
      timeout.unref();
    }

    const completion = new Promise<CommandResult>((resolve) => {
      child.on("close", (exitCode, signal) => {
        settled = true;
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        if (forceKillTimeout !== undefined) {
          clearTimeout(forceKillTimeout);
        }
        spec.signal?.removeEventListener("abort", abort);
        flushLine(stdoutLines);
        flushLine(stderrLines);
        resolve({
          exitCode,
          signal,
          stdout,
          stderr,
          durationMs: performance.now() - startedAt,
          timedOut,
          cancelled,
          ...(spawnError === undefined ? {} : { spawnError })
        });
      });
    });

    const stop = (): Promise<CommandResult> => {
      terminate();
      return completion;
    };

    if (spec.signal?.aborted === true) {
      abort();
    }

    return { completion, stop };
  }
}
