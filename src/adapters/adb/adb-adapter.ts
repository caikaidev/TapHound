import { normalizeObservedActivityComponent } from "../../domain/activity.js";
import type {
  AdbPort,
  AppIdentity,
  DeviceInfo,
  LogcatOptions
} from "../../ports/adb.js";
import type { Point } from "../../ports/android-cli.js";
import type {
  CommandResult,
  ProcessRunner,
  RunningCommand
} from "../../ports/process-runner.js";

function deviceArgs(deviceSerial?: string): string[] {
  return deviceSerial === undefined ? [] : ["-s", deviceSerial];
}

function quoteRemoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function inputTextChunks(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length - 1; index += 1) {
    if (text[index] === "%" && text[index + 1] === "s") {
      chunks.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  chunks.push(text.slice(start));
  return chunks;
}

export class AdbAdapter implements AdbPort {
  public constructor(private readonly runner: ProcessRunner) {}

  private run(
    args: readonly string[],
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<CommandResult> {
    return this.runner.run({
      executable: "adb",
      args,
      ...(signal === undefined ? {} : { signal }),
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    });
  }

  public async devices(signal?: AbortSignal): Promise<readonly DeviceInfo[]> {
    const result = await this.run(["devices"], signal);
    return result.stdout
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [serial, status] = line.split(/\s+/, 2);
        if (serial === undefined || status === undefined) {
          throw new Error(`Invalid adb devices line: ${line}`);
        }
        return { serial, status };
      });
  }

  public async currentActivity(identity: AppIdentity): Promise<string> {
    const result = await this.run([
      ...deviceArgs(identity.deviceSerial),
      "shell",
      "dumpsys",
      "activity",
      "activities"
    ], identity.signal, identity.timeoutMs);
    const resumed = result.stdout.split(/\r?\n/).find(
      (line) => /\b(?:mResumedActivity|topResumedActivity|ResumedActivity)\s*[:=]/
        .test(line)
    );
    const component = resumed === undefined
      ? null
      : /\b([A-Za-z_$][\w.$]*)\/(\.?[A-Za-z_$][\w.$]*)\b/.exec(resumed);
    if (component?.[1] === undefined || component[2] === undefined) {
      throw new Error("ADB did not report a resumed Activity");
    }
    return normalizeObservedActivityComponent(
      `${component[1]}/${component[2]}`
    );
  }

  public async pid(identity: AppIdentity): Promise<number | null> {
    const result = await this.run([
      ...deviceArgs(identity.deviceSerial),
      "shell",
      "pidof",
      identity.packageName
    ], identity.signal, identity.timeoutMs);
    const value = result.stdout.trim();
    if (value.length === 0) {
      return null;
    }
    const firstPid = value.split(/\s+/)[0];
    if (firstPid === undefined || !/^\d+$/.test(firstPid)) {
      throw new Error(`Invalid PID from adb: ${value}`);
    }
    return Number(firstPid);
  }

  public tap(
    point: Point,
    deviceSerial: string,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    return this.run([
      ...deviceArgs(deviceSerial),
      "shell",
      "input",
      "tap",
      String(point.x),
      String(point.y)
    ], signal);
  }

  public longClick(
    point: Point,
    durationMs: number,
    deviceSerial: string,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    return this.swipe(point, point, durationMs, deviceSerial, signal);
  }

  public swipe(
    from: Point,
    to: Point,
    durationMs: number,
    deviceSerial: string,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    return this.run([
      ...deviceArgs(deviceSerial),
      "shell",
      "input",
      "swipe",
      String(from.x),
      String(from.y),
      String(to.x),
      String(to.y),
      String(durationMs)
    ], signal);
  }

  public back(
    deviceSerial: string,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    return this.run([
      ...deviceArgs(deviceSerial),
      "shell",
      "input",
      "keyevent",
      "BACK"
    ], signal);
  }

  public async inputText(
    text: string,
    deviceSerial: string,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    let result: CommandResult | undefined;
    for (const chunk of inputTextChunks(text)) {
      result = await this.run([
        ...deviceArgs(deviceSerial),
        "shell",
        "input",
        "text",
        quoteRemoteShellArgument(chunk)
      ], signal);
      if (
        result.exitCode !== 0
        || result.timedOut
        || result.cancelled
        || result.spawnError !== undefined
      ) {
        return result;
      }
    }
    if (result === undefined) {
      throw new Error("ADB input text produced no command");
    }
    return result;
  }

  public startLogcat(options: LogcatOptions): RunningCommand {
    return this.runner.start({
      executable: "adb",
      args: [
        ...deviceArgs(options.deviceSerial),
        "logcat",
        "-v",
        "threadtime",
        ...(options.pid === undefined
          ? []
          : [`--pid=${String(options.pid)}`])
      ],
      ...(options.signal === undefined ? {} : { signal: options.signal })
    }, {
      onStdoutLine: options.onStdoutLine,
      ...(options.onStderrLine === undefined
        ? {}
        : { onStderrLine: options.onStderrLine })
    });
  }
}
