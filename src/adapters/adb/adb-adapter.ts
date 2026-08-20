import {
  parseObservedActivityComponent,
  type ForegroundComponent
} from "../../domain/activity.js";
import {
  isAppProcessName,
  type AppProcess
} from "../../domain/app-process.js";
import type {
  AdbPort,
  AppIdentity,
  DeviceInfo,
  LaunchActivityOptions,
  LogcatOptions
} from "../../ports/adb.js";
import type { Point } from "../../ports/android-cli.js";
import type {
  CommandResult,
  ProcessRunner,
  RunningCommand
} from "../../ports/process-runner.js";
import {
  WindowTopologySchema,
  type WindowTopology
} from "../../domain/window-hierarchy.js";
import { parseWindowTopology } from "./window-topology-parser.js";

const PROCESS_ROW = /^(\d+)\s+(\S+)$/;

function deviceArgs(deviceSerial?: string): string[] {
  return deviceSerial === undefined ? [] : ["-s", deviceSerial];
}

function assertCommandUsable(
  result: CommandResult,
  operation: string
): void {
  if (result.spawnError !== undefined) {
    throw new Error(`ADB ${operation} failed: ${result.spawnError}`);
  }
  if (result.timedOut) {
    throw new Error(`ADB ${operation} timed out`);
  }
  if (result.cancelled) {
    throw new Error(`ADB ${operation} was cancelled`);
  }
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

  public async foregroundComponent(
    identity: AppIdentity
  ): Promise<ForegroundComponent> {
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
    return parseObservedActivityComponent(
      `${component[1]}/${component[2]}`
    );
  }

  public async currentActivity(identity: AppIdentity): Promise<string> {
    return (await this.foregroundComponent(identity)).activity;
  }

  public async isInstalled(identity: AppIdentity): Promise<boolean> {
    const result = await this.run([
      ...deviceArgs(identity.deviceSerial),
      "shell",
      "pm",
      "path",
      identity.packageName
    ], identity.signal, identity.timeoutMs);
    assertCommandUsable(result, "pm path");
    return /^package:/m.test(result.stdout);
  }

  public launchActivity(
    options: LaunchActivityOptions
  ): Promise<CommandResult> {
    return this.run([
      ...deviceArgs(options.deviceSerial),
      "shell",
      "am",
      "start",
      "-W",
      "-n",
      `${options.packageName}/${options.activity}`
    ], options.signal, options.timeoutMs);
  }

  public forceStop(identity: AppIdentity): Promise<CommandResult> {
    return this.run([
      ...deviceArgs(identity.deviceSerial),
      "shell",
      "am",
      "force-stop",
      identity.packageName
    ], identity.signal, identity.timeoutMs);
  }

  public async appProcesses(
    identity: AppIdentity
  ): Promise<readonly AppProcess[]> {
    const result = await this.run([
      ...deviceArgs(identity.deviceSerial),
      "shell",
      "ps",
      "-A",
      "-o",
      "PID,NAME"
    ], identity.signal, identity.timeoutMs);
    assertCommandUsable(result, "ps");
    if (result.exitCode !== 0) {
      throw new Error(
        `ADB ps failed: ${result.stderr.trim() || `exit ${String(result.exitCode)}`}`
      );
    }
    return result.stdout
      .split(/\r?\n/)
      .flatMap((line) => {
        const row = PROCESS_ROW.exec(line.trim());
        if (row?.[1] === undefined || row[2] === undefined) {
          return [];
        }
        if (!isAppProcessName(row[2], identity.packageName)) {
          return [];
        }
        const pid = Number(row[1]);
        if (!Number.isSafeInteger(pid) || pid <= 0) {
          throw new Error(`Invalid PID from adb ps: ${row[1]}`);
        }
        return [{ pid, name: row[2] }];
      })
      .sort((left, right) => left.pid - right.pid);
  }

  public async windowTopology(
    identity: AppIdentity
  ): Promise<WindowTopology> {
    const result = await this.run([
      ...deviceArgs(identity.deviceSerial),
      "shell",
      "dumpsys",
      "window",
      "windows"
    ], identity.signal, identity.timeoutMs);
    if (result.cancelled) {
      throw new Error("ADB window topology was cancelled");
    }
    if (
      result.exitCode !== 0
      || result.timedOut
      || result.spawnError !== undefined
    ) {
      return WindowTopologySchema.parse({
        version: 1,
        status: "unavailable",
        windows: [],
        diagnostic: result.stderr.trim()
          || result.spawnError
          || (result.timedOut
            ? "ADB window topology timed out"
            : `ADB window topology exited with code ${String(result.exitCode)}`)
      });
    }
    const topology = parseWindowTopology(
      result.stdout,
      identity.packageName
    );
    if (topology.windows.length > 0) return topology;
    return WindowTopologySchema.parse({
      version: 1,
      status: "unavailable",
      windows: [],
      diagnostic: "ADB window topology contained no visible touchable target-app windows"
    });
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
        "threadtime"
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
