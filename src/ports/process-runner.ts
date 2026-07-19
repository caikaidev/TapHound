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
  spawnError?: string | undefined;
}

export interface StreamHandlers {
  onStdoutLine?(line: string): void;
  onStderrLine?(line: string): void;
}

export interface RunningCommand {
  readonly completion: Promise<CommandResult>;
  stop(): Promise<CommandResult>;
}

export interface ProcessRunner {
  run(spec: CommandSpec): Promise<CommandResult>;
  start(spec: CommandSpec, handlers?: StreamHandlers): RunningCommand;
}
