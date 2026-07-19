import type { Point } from "./android-cli.js";
import type {
  CommandResult,
  RunningCommand
} from "./process-runner.js";

export interface DeviceInfo {
  serial: string;
  status: string;
}

export interface AppIdentity {
  packageName: string;
  deviceSerial: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface LogcatOptions {
  deviceSerial: string;
  pid?: number | undefined;
  onStdoutLine: (line: string) => void;
  onStderrLine?: ((line: string) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export interface AdbPort {
  devices: (signal?: AbortSignal) => Promise<readonly DeviceInfo[]>;
  currentActivity: (identity: AppIdentity) => Promise<string>;
  pid: (identity: AppIdentity) => Promise<number | null>;
  tap: (
    point: Point,
    deviceSerial: string,
    signal?: AbortSignal
  ) => Promise<CommandResult>;
  longClick: (
    point: Point,
    durationMs: number,
    deviceSerial: string,
    signal?: AbortSignal
  ) => Promise<CommandResult>;
  swipe: (
    from: Point,
    to: Point,
    durationMs: number,
    deviceSerial: string,
    signal?: AbortSignal
  ) => Promise<CommandResult>;
  back: (
    deviceSerial: string,
    signal?: AbortSignal
  ) => Promise<CommandResult>;
  inputText: (
    text: string,
    deviceSerial: string,
    signal?: AbortSignal
  ) => Promise<CommandResult>;
  startLogcat: (options: LogcatOptions) => RunningCommand;
}
