import type {
  AdbPort,
  LogcatOptions
} from "../../ports/adb.js";
import type { Clock } from "../../ports/clock.js";
import type {
  CommandResult,
  RunningCommand
} from "../../ports/process-runner.js";

export type LogLevel = "V" | "D" | "I" | "W" | "E" | "F" | "A";

export interface LogcatLine {
  receivedAt: number;
  raw: string;
  pid?: number | undefined;
  tid?: number | undefined;
  level?: LogLevel | undefined;
  tag?: string | undefined;
  message?: string | undefined;
}

export interface LogcatMetadata {
  deviceSerial: string;
  pid?: number | undefined;
}

export interface StartLogcatOptions {
  deviceSerial: string;
  pid?: number | undefined;
  signal?: AbortSignal | undefined;
}

const THREADTIME = /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+([^:]+):\s?(.*)$/;

function parseLine(raw: string, receivedAt: number): LogcatLine {
  const match = THREADTIME.exec(raw);
  if (match === null) {
    return { receivedAt, raw };
  }

  const [, pid, tid, level, tag, message] = match;
  if (
    pid === undefined
    || tid === undefined
    || level === undefined
    || tag === undefined
    || message === undefined
  ) {
    return { receivedAt, raw };
  }
  return {
    receivedAt,
    raw,
    pid: Number(pid),
    tid: Number(tid),
    level: level as LogLevel,
    tag: tag.trim(),
    message
  };
}

export class LogcatCollector {
  private readonly collected: LogcatLine[] = [];
  private readonly stderr: string[] = [];
  private running?: RunningCommand | undefined;
  private streamMetadata?: LogcatMetadata | undefined;
  private stopPromise?: Promise<CommandResult> | undefined;

  public constructor(
    private readonly adb: AdbPort,
    private readonly clock: Clock
  ) {}

  public start(options: StartLogcatOptions): void {
    if (this.running !== undefined) {
      throw new Error("Logcat collector already started");
    }

    const logcatOptions: LogcatOptions = {
      deviceSerial: options.deviceSerial,
      onStdoutLine: (line): void => {
        this.collected.push(parseLine(line, this.clock.now()));
      },
      onStderrLine: (line): void => {
        this.stderr.push(line);
      },
      ...(options.pid === undefined ? {} : { pid: options.pid }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    };
    this.running = this.adb.startLogcat(logcatOptions);
    this.streamMetadata = {
      deviceSerial: options.deviceSerial,
      ...(options.pid === undefined ? {} : { pid: options.pid })
    };
  }

  public scopeToPid(pid: number): void {
    if (this.streamMetadata === undefined) {
      throw new Error("Logcat collector has not started");
    }
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error("Logcat PID must be a positive integer");
    }
    this.streamMetadata = {
      ...this.streamMetadata,
      pid
    };
  }

  public metadata(): LogcatMetadata {
    if (this.streamMetadata === undefined) {
      throw new Error("Logcat collector has not started");
    }
    return { ...this.streamMetadata };
  }

  public lines(): readonly LogcatLine[] {
    const pid = this.streamMetadata?.pid;
    return this.collected.filter(
      (line) => pid === undefined || line.pid === undefined || line.pid === pid
    );
  }

  public diagnosticLines(): readonly string[] {
    return [...this.stderr];
  }

  public linesBetween(startedAt: number, finishedAt: number): LogcatLine[] {
    return this.lines().filter(
      (line) => line.receivedAt >= startedAt && line.receivedAt <= finishedAt
    );
  }

  public stop(): Promise<CommandResult> {
    if (this.running === undefined) {
      throw new Error("Logcat collector has not started");
    }
    this.stopPromise ??= this.running.stop();
    return this.stopPromise;
  }
}
