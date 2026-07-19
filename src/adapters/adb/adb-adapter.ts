import { normalizeActivity } from "../../domain/activity.js";
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

function encodeInputText(text: string): string {
  return text
    .replaceAll("%", "%25")
    .replaceAll(" ", "%s");
}

export class AdbAdapter implements AdbPort {
  public constructor(private readonly runner: ProcessRunner) {}

  private run(
    args: readonly string[],
    signal?: AbortSignal
  ): Promise<CommandResult> {
    return this.runner.run({
      executable: "adb",
      args,
      ...(signal === undefined ? {} : { signal })
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
    ], identity.signal);
    const component = /\b([A-Za-z_$][\w.$]*)\/(\.?[A-Za-z_$][\w.$]*)\b/
      .exec(result.stdout);
    if (component?.[1] === undefined || component[2] === undefined) {
      throw new Error("ADB did not report a resumed Activity");
    }
    return normalizeActivity(
      identity.packageName,
      `${component[1]}/${component[2]}`
    );
  }

  public async pid(identity: AppIdentity): Promise<number | null> {
    const result = await this.run([
      ...deviceArgs(identity.deviceSerial),
      "shell",
      "pidof",
      identity.packageName
    ], identity.signal);
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

  public inputText(
    text: string,
    deviceSerial: string,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    return this.run([
      ...deviceArgs(deviceSerial),
      "shell",
      "input",
      "text",
      encodeInputText(text)
    ], signal);
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
