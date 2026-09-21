export interface CommandSpec {
  executable: string;
  args: readonly string[];
  cwd?: string | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  terminationRequested?: boolean | undefined;
  spawnError?: string | undefined;
}

export interface StreamHandlers {
  onStdoutLine?(line: string): void;
  onStderrLine?(line: string): void;
  /**
   * Long-lived streams may disable aggregate capture while still consuming
   * complete lines through the callbacks above.
   */
  captureStdout?: boolean | undefined;
  captureStderr?: boolean | undefined;
}

export interface RunningCommand {
  /** Resolves undefined once the stream remains alive through startup. */
  readonly started: Promise<CommandResult | undefined>;
  readonly completion: Promise<CommandResult>;
  stop: () => Promise<CommandResult>;
}

export interface ProcessRunner {
  run: (spec: CommandSpec) => Promise<CommandResult>;
  start: (spec: CommandSpec, handlers?: StreamHandlers) => RunningCommand;
}
