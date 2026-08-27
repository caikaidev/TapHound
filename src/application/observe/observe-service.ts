import {
  ObserveReportSchema,
  type ObserveReport
} from "../../domain/observation.js";
import type { AdbPort } from "../../ports/adb.js";
import type { AndroidCliPort } from "../../ports/android-cli.js";
import type { CommandResult } from "../../ports/process-runner.js";

export interface ObserveInput {
  packageName: string;
  deviceSerial: string;
  logcatLines?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface ObserveDependencies {
  adb: AdbPort;
  androidCli: AndroidCliPort;
  layoutTimeoutMs: number;
}

function failedCommand(result: CommandResult): boolean {
  return result.exitCode !== 0
    || result.spawnError !== undefined
    || result.timedOut
    || result.cancelled;
}

function splitLogcat(stdout: string): string[] {
  const lines = stdout.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export class ObserveService {
  public constructor(
    private readonly dependencies: ObserveDependencies
  ) {}

  public async observe(input: ObserveInput): Promise<ObserveReport> {
    const { packageName, deviceSerial, logcatLines, signal } = input;
    const identity = {
      packageName,
      deviceSerial,
      ...(signal === undefined ? {} : { signal })
    };

    const foreground = await this.dependencies.adb.foregroundComponent(identity);

    let activity: string | undefined;
    try {
      activity = await this.dependencies.adb.currentActivity(identity);
    } catch (error) {
      if (foreground.packageName === packageName) {
        throw error;
      }
      activity = undefined;
    }

    const layout = await this.dependencies.androidCli.layout({
      deviceSerial,
      packageName,
      timeoutMs: this.dependencies.layoutTimeoutMs,
      ...(signal === undefined ? {} : { signal })
    });

    let logcat: string[] | undefined;
    if (logcatLines !== undefined && logcatLines > 0) {
      const result = await this.dependencies.adb.dumpLogcat({
        deviceSerial,
        maxLines: logcatLines,
        ...(signal === undefined ? {} : { signal })
      });
      if (failedCommand(result)) {
        throw new Error(
          result.stderr.trim()
            || result.spawnError
            || "Logcat dump failed"
        );
      }
      logcat = splitLogcat(result.stdout);
    }

    return ObserveReportSchema.parse({
      deviceSerial,
      packageName,
      ...(activity === undefined ? {} : { activity }),
      foreground,
      layout,
      ...(logcat === undefined ? {} : { logcat })
    });
  }
}
