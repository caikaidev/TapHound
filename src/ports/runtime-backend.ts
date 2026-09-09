import type { ForegroundComponent } from "../domain/activity.js";
import type { AppProcess } from "../domain/app-process.js";
import type { Point } from "../domain/geometry.js";
import type {
  DeviceInfo,
  RuntimeBackendDescriptor,
  RuntimeCapabilities
} from "../domain/runtime.js";
import type { WindowTopology } from "../domain/window-hierarchy.js";
import type { UiBackendSelection } from "../domain/ui-backend.js";
import type { AnnotatedScreenResolverPort } from "./annotated-screen-resolver.js";
import type {
  CommandResult,
  RunningCommand
} from "./process-runner.js";
import type { UiSnapshotProvider } from "./ui-snapshot.js";
import type { UiStabilityProbe } from "./ui-stability.js";

export interface OpenRuntimeSessionOptions {
  deviceSerial: string;
  signal?: AbortSignal | undefined;
}

export interface OpenRuntimeUiSnapshotsOptions {
  timeoutMs?: number | undefined;
  backend?: UiBackendSelection | undefined;
  cacheEnabled?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface RuntimeAppQuery {
  packageName: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface RuntimeLaunchOptions extends RuntimeAppQuery {
  activity: string;
}

export interface RuntimeLogcatStreamOptions {
  onStdoutLine: (line: string) => void;
  onStderrLine?: ((line: string) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export interface RuntimeDumpLogcatOptions {
  maxLines: number;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface RuntimeScreenshotOptions {
  outputPath: string;
  annotate?: boolean | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface RuntimeIntentOptions {
  action: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface RuntimeSession {
  readonly descriptor: RuntimeBackendDescriptor;
  readonly deviceSerial: string;

  openUiSnapshots(
    options?: OpenRuntimeUiSnapshotsOptions
  ): Promise<UiSnapshotProvider>;

  isInstalled(app: RuntimeAppQuery): Promise<boolean>;
  launchApp(options: RuntimeLaunchOptions): Promise<CommandResult>;
  forceStop(app: RuntimeAppQuery): Promise<CommandResult>;
  readonly currentActivity:
    | ((app: RuntimeAppQuery) => Promise<string>)
    | undefined;
  readonly foregroundComponent:
    | ((app: RuntimeAppQuery) => Promise<ForegroundComponent>)
    | undefined;
  readonly appProcesses:
    | ((app: RuntimeAppQuery) => Promise<readonly AppProcess[]>)
    | undefined;
  readonly windowTopology:
    | ((app: RuntimeAppQuery) => Promise<WindowTopology>)
    | undefined;

  tap(point: Point, signal?: AbortSignal): Promise<CommandResult>;
  longClick(
    point: Point,
    durationMs: number,
    signal?: AbortSignal
  ): Promise<CommandResult>;
  swipe(
    from: Point,
    to: Point,
    durationMs: number,
    signal?: AbortSignal
  ): Promise<CommandResult>;
  back(signal?: AbortSignal): Promise<CommandResult>;
  inputText(text: string, signal?: AbortSignal): Promise<CommandResult>;

  readonly startLogcat:
    | ((options: RuntimeLogcatStreamOptions) => RunningCommand)
    | undefined;
  readonly dumpLogcat:
    | ((options: RuntimeDumpLogcatOptions) => Promise<CommandResult>)
    | undefined;

  captureScreenshot(
    options: RuntimeScreenshotOptions
  ): Promise<CommandResult>;
  readonly annotatedScreens: AnnotatedScreenResolverPort | undefined;
  readonly uiStability: UiStabilityProbe;
  readonly startActivityByIntent:
    | ((options: RuntimeIntentOptions) => Promise<CommandResult>)
    | undefined;

  close(): Promise<void>;
}

export interface RuntimeBackend {
  readonly descriptor: RuntimeBackendDescriptor;
  readonly capabilities: RuntimeCapabilities;
  listDevices(signal?: AbortSignal): Promise<readonly DeviceInfo[]>;
  openSession(
    options: OpenRuntimeSessionOptions
  ): Promise<RuntimeSession>;
}
