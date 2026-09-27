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
  /** Device threadtime timestamp without a year; receivedAt remains the monotonic window clock. */
  deviceTimestamp?: string | undefined;
  raw: string;
  pid?: number | undefined;
  tid?: number | undefined;
  level?: LogLevel | undefined;
  tag?: string | undefined;
  message?: string | undefined;
}

export interface LogcatMetadata {
  deviceSerial: string;
  pids: readonly number[];
  droppedLines?: number | undefined;
  droppedBytes?: number | undefined;
  lastDroppedAtMs?: number | undefined;
}

export interface StartLogcatOptions {
  deviceSerial: string;
  pids?: readonly number[] | undefined;
  signal?: AbortSignal | undefined;
}

const THREADTIME = /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.+?):\s(.*)$/;

interface DroppedEvidence {
  lines: number;
  bytes: number;
  lastDroppedAt: number;
}

function parseLine(raw: string, receivedAt: number): LogcatLine {
  const match = THREADTIME.exec(raw);
  if (match === null) {
    return { receivedAt, raw };
  }

  const [, deviceTimestamp, pid, tid, level, tag, message] = match;
  if (
    deviceTimestamp === undefined
    ||
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
    deviceTimestamp,
    raw,
    pid: Number(pid),
    tid: Number(tid),
    level: level as LogLevel,
    tag: tag.trim(),
    message
  };
}

function startupFailure(result: CommandResult): string {
  return result.stderr.trim()
    || result.spawnError
    || (result.cancelled
      ? "Logcat startup was cancelled"
      : result.timedOut
        ? "Logcat startup timed out"
        : `Logcat exited during startup with code ${String(result.exitCode)}`);
}

const COMPACT_THRESHOLD = 1024;

export class LogcatCollector {
  /** Live lines are `collected[head..]`; dropped lines are compacted lazily. */
  private readonly collected: LogcatLine[] = [];
  private head = 0;
  private bufferedBytes = 0;
  private readonly droppedByPid = new Map<number | undefined, DroppedEvidence>();
  private readonly stderr: string[] = [];
  private readonly scopedPids = new Set<number>();
  private running?: RunningCommand | undefined;
  private streamMetadata?: { deviceSerial: string } | undefined;
  private stopPromise?: Promise<CommandResult> | undefined;

  public constructor(
    private readonly adb: AdbPort,
    private readonly clock: Clock,
    private readonly limits: { maxLines: number; maxBytes: number } = {
      maxLines: 10000,
      maxBytes: 2 * 1024 * 1024
    }
  ) {
    if (!Number.isInteger(limits.maxLines) || limits.maxLines < 1
      || !Number.isInteger(limits.maxBytes) || limits.maxBytes < 1) {
      throw new Error("Logcat buffer limits must be positive integers");
    }
  }

  private append(line: string): void {
    const parsed = parseLine(line, this.clock.now());
    if (this.scopedPids.size > 0 && parsed.pid !== undefined
      && !this.scopedPids.has(parsed.pid)) {
      return;
    }
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    this.collected.push(parsed);
    this.bufferedBytes += bytes;
    while (
      this.collected.length - this.head > this.limits.maxLines
      || this.bufferedBytes > this.limits.maxBytes
    ) {
      const dropped = this.collected[this.head];
      if (dropped === undefined) {
        break;
      }
      this.head += 1;
      const size = Buffer.byteLength(dropped.raw, "utf8") + 1;
      this.bufferedBytes -= size;
      const previous = this.droppedByPid.get(dropped.pid);
      this.droppedByPid.set(dropped.pid, {
        lines: (previous?.lines ?? 0) + 1,
        bytes: (previous?.bytes ?? 0) + size,
        lastDroppedAt: dropped.receivedAt
      });
    }
    // Array#shift is O(n); a saturated buffer would otherwise move every
    // retained line on each append. Compaction is amortized O(1) per line.
    if (
      this.head >= COMPACT_THRESHOLD
      && this.head * 2 >= this.collected.length
    ) {
      this.collected.splice(0, this.head);
      this.head = 0;
    }
  }

  private retained(): LogcatLine[] {
    return this.head === 0 ? this.collected : this.collected.slice(this.head);
  }

  private addScopedPids(pids: readonly number[]): void {
    for (const pid of pids) {
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error("Logcat PID must be a positive integer");
      }
      this.scopedPids.add(pid);
    }
  }

  private droppedEvidence(): DroppedEvidence | undefined {
    const relevant = [
      this.droppedByPid.get(undefined),
      ...[...this.scopedPids].map((pid) => this.droppedByPid.get(pid))
    ].filter((entry): entry is DroppedEvidence => entry !== undefined);
    if (relevant.length === 0) {
      return undefined;
    }
    return {
      lines: relevant.reduce((total, entry) => total + entry.lines, 0),
      bytes: relevant.reduce((total, entry) => total + entry.bytes, 0),
      lastDroppedAt: Math.max(...relevant.map((entry) => entry.lastDroppedAt))
    };
  }

  public async start(options: StartLogcatOptions): Promise<void> {
    if (this.running !== undefined) {
      throw new Error("Logcat collector already started");
    }
    this.addScopedPids(options.pids ?? []);

    const logcatOptions: LogcatOptions = {
      deviceSerial: options.deviceSerial,
      onStdoutLine: (line): void => {
        this.append(line);
      },
      onStderrLine: (line): void => {
        this.stderr.push(line);
        if (this.stderr.length > 100) {
          this.stderr.shift();
        }
      },
      ...(options.signal === undefined ? {} : { signal: options.signal })
    };
    this.running = this.adb.startLogcat(logcatOptions);
    this.streamMetadata = { deviceSerial: options.deviceSerial };
    const startupResult = await this.running.started;
    if (startupResult !== undefined) {
      throw new Error(
        this.stderr.join("\n").trim() || startupFailure(startupResult)
      );
    }
  }

  public scopeToPids(pids: readonly number[]): void {
    if (this.streamMetadata === undefined) {
      throw new Error("Logcat collector has not started");
    }
    this.addScopedPids(pids);
  }

  public metadata(): LogcatMetadata {
    if (this.streamMetadata === undefined) {
      throw new Error("Logcat collector has not started");
    }
    const dropped = this.droppedEvidence();
    return {
      deviceSerial: this.streamMetadata.deviceSerial,
      pids: [...this.scopedPids].sort((left, right) => left - right),
      ...(dropped === undefined ? {} : {
        droppedLines: dropped.lines,
        droppedBytes: dropped.bytes,
        lastDroppedAtMs: dropped.lastDroppedAt
      })
    };
  }

  public lines(): readonly LogcatLine[] {
    if (this.scopedPids.size === 0) {
      return [];
    }
    return this.retained().filter(
      (line) => line.pid !== undefined && this.scopedPids.has(line.pid)
    );
  }

  /** Includes unparsed lines as raw artifacts, within the declared buffer limit. */
  public rawLines(): readonly LogcatLine[] {
    return this.retained().filter(
      (line) => line.pid === undefined || this.scopedPids.has(line.pid)
    );
  }

  public completeSince(startedAt: number): boolean {
    const dropped = this.droppedEvidence();
    return dropped === undefined || dropped.lastDroppedAt < startedAt;
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
