import type { Point } from "./android-cli.js";
import type { ForegroundComponent } from "../domain/activity.js";
import type { AppProcess } from "../domain/app-process.js";
import type { WindowTopology } from "../domain/window-hierarchy.js";
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

export interface LaunchActivityOptions {
  packageName: string;
  activity: string;
  deviceSerial: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface StartActivityByIntentOptions {
  action: string;
  deviceSerial: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface ResolveLauncherActivityOptions {
  packageName: string;
  deviceSerial: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface ResolvedActivity {
  packageName: string;
  activity: string;
}

export interface LogcatOptions {
  deviceSerial: string;
  onStdoutLine: (line: string) => void;
  onStderrLine?: ((line: string) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export interface DumpLogcatOptions {
  deviceSerial: string;
  maxLines: number;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface AdbPort {
  devices: (signal?: AbortSignal) => Promise<readonly DeviceInfo[]>;
  foregroundComponent: (
    identity: AppIdentity
  ) => Promise<ForegroundComponent>;
  currentActivity: (identity: AppIdentity) => Promise<string>;
  isInstalled: (identity: AppIdentity) => Promise<boolean>;
  launchActivity: (options: LaunchActivityOptions) => Promise<CommandResult>;
  startActivityByIntent: (
    options: StartActivityByIntentOptions
  ) => Promise<CommandResult>;
  resolveLauncherActivity: (
    options: ResolveLauncherActivityOptions
  ) => Promise<ResolvedActivity | undefined>;
  forceStop: (identity: AppIdentity) => Promise<CommandResult>;
  appProcesses: (identity: AppIdentity) => Promise<readonly AppProcess[]>;
  windowTopology: (identity: AppIdentity) => Promise<WindowTopology>;
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
  dumpLogcat: (options: DumpLogcatOptions) => Promise<CommandResult>;
}
