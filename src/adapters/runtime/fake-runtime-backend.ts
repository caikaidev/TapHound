import { createHash } from "node:crypto";

import type {
  AnnotatedScreenResolverPort
} from "../../ports/annotated-screen-resolver.js";
import type {
  CommandResult,
  RunningCommand
} from "../../ports/process-runner.js";
import type {
  OpenRuntimeSessionOptions,
  RuntimeAppQuery,
  RuntimeBackend,
  RuntimeDumpLogcatOptions,
  RuntimeIntentOptions,
  RuntimeLaunchOptions,
  RuntimeLogcatStreamOptions,
  RuntimeScreenshotOptions,
  RuntimeSession
} from "../../ports/runtime-backend.js";
import type {
  UiSnapshot,
  UiSnapshotProvider
} from "../../ports/ui-snapshot.js";
import type { UiStabilityProbe } from "../../ports/ui-stability.js";
import type { ForegroundComponent } from "../../domain/activity.js";
import type { AppProcess } from "../../domain/app-process.js";
import type { DisplayViewport } from "../../domain/geometry.js";
import type {
  DeviceInfo,
  RuntimeBackendDescriptor,
  RuntimeCapabilities
} from "../../domain/runtime.js";
import type { WindowTopology } from "../../domain/window-hierarchy.js";

export const FAKE_RUNTIME_ADAPTER_VERSION = "fake-runtime-v1";

export function fakeRuntimeCapabilities(): RuntimeCapabilities {
  return {
    layoutSnapshot: true,
    screenshot: true,
    annotatedScreens: false,
    frameStatsIdle: false,
    logs: true,
    processDiscovery: true,
    windowTopology: false,
    intentStart: false,
    foregroundActivity: false
  };
}

function successResult(): CommandResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    timedOut: false,
    cancelled: false
  };
}

function fakeViewport(): DisplayViewport {
  return {
    width: 1080,
    height: 1920,
    rotation: 0,
    coordinateSpace: "physicalDisplayPixels"
  };
}

export function fakeRuntimeUiSnapshotProvider(
  provider?: Partial<UiSnapshotProvider>
): UiSnapshotProvider {
  const descriptor = {
    id: "system-uiautomator" as const,
    adapterVersion: "fake-runtime-v1",
    configSha256: "0".repeat(64)
  };
  return {
    descriptor,
    capture: (): Promise<UiSnapshot> => Promise.resolve({
      observationId: "fake-observation",
      capturedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 0,
      backend: descriptor,
      viewport: fakeViewport(),
      roots: []
    }),
    close: (): Promise<void> => Promise.resolve(),
    ...(provider === undefined ? {} : provider)
  };
}

export interface FakeRuntimeSessionState {
  installed?: boolean | undefined;
  foreground?: ForegroundComponent | undefined;
  processes?: readonly AppProcess[] | undefined;
  topology?: WindowTopology | undefined;
  currentActivity?: string | undefined;
}

export class FakeRuntimeSession implements RuntimeSession {
  public readonly descriptor: RuntimeBackendDescriptor;
  public readonly deviceSerial: string;
  public readonly uiSnapshotProvider: UiSnapshotProvider;
  public readonly capabilities: RuntimeCapabilities;
  public readonly currentActivity:
    | ((app: RuntimeAppQuery) => Promise<string>)
    | undefined;
  public readonly foregroundComponent:
    | ((app: RuntimeAppQuery) => Promise<ForegroundComponent>)
    | undefined;
  public readonly appProcesses:
    | ((app: RuntimeAppQuery) => Promise<readonly AppProcess[]>)
    | undefined;
  public readonly windowTopology:
    | ((app: RuntimeAppQuery) => Promise<WindowTopology>)
    | undefined;
  public readonly startLogcat:
    | ((options: RuntimeLogcatStreamOptions) => RunningCommand)
    | undefined;
  public readonly dumpLogcat:
    | ((options: RuntimeDumpLogcatOptions) => Promise<CommandResult>)
    | undefined;
  public annotatedScreens: AnnotatedScreenResolverPort | undefined = undefined;
  public uiStability: UiStabilityProbe;
  public startActivityByIntent:
    | ((options: RuntimeIntentOptions) => Promise<CommandResult>)
    | undefined = undefined;

  public state: FakeRuntimeSessionState;
  public readonly calls: string[] = [];
  private openedUiSnapshots: UiSnapshotProvider | undefined;

  public constructor(input: {
    descriptor: RuntimeBackendDescriptor;
    deviceSerial: string;
    state?: FakeRuntimeSessionState | undefined;
    uiSnapshots?: UiSnapshotProvider | undefined;
    uiStability?: UiStabilityProbe | undefined;
  }) {
    this.descriptor = input.descriptor;
    this.deviceSerial = input.deviceSerial;
    this.capabilities = input.descriptor.capabilities;
    this.state = input.state ?? {};
    this.uiSnapshotProvider = input.uiSnapshots
      ?? fakeRuntimeUiSnapshotProvider();
    this.uiStability = input.uiStability ?? {
      reset: (): void => undefined,
      sample: (): Promise<readonly unknown[]> => Promise.resolve([])
    };
    this.currentActivity = this.capabilities.foregroundActivity
      ? (app: RuntimeAppQuery): Promise<string> => {
        this.calls.push(`currentActivity:${app.packageName}`);
        return Promise.resolve(
          this.state.currentActivity ?? "com.example.app.FakeActivity"
        );
      }
      : undefined;
    this.foregroundComponent = this.capabilities.foregroundActivity
      ? (app: RuntimeAppQuery): Promise<ForegroundComponent> => {
        this.calls.push(`foregroundComponent:${app.packageName}`);
        return Promise.resolve(this.state.foreground ?? {
          packageName: "com.example.app",
          activity: "com.example.app.FakeActivity"
        });
      }
      : undefined;
    this.appProcesses = this.capabilities.processDiscovery
      ? (app: RuntimeAppQuery): Promise<readonly AppProcess[]> => {
        this.calls.push(`appProcesses:${app.packageName}`);
        return Promise.resolve(
          this.state.processes ?? [{ pid: 42, name: "com.example.app" }]
        );
      }
      : undefined;
    this.windowTopology = this.capabilities.windowTopology
      ? (app: RuntimeAppQuery): Promise<WindowTopology> => {
        this.calls.push(`windowTopology:${app.packageName}`);
        return Promise.resolve(this.state.topology ?? {
          version: 1,
          status: "unavailable",
          windows: [],
          diagnostic: "fake runtime backend has no window topology"
        });
      }
      : undefined;
    this.startLogcat = this.capabilities.logs
      ? (options: RuntimeLogcatStreamOptions): RunningCommand => {
        this.calls.push("startLogcat");
        const completion = Promise.resolve(successResult());
        return {
          started: Promise.resolve(undefined),
          completion,
          stop: (): Promise<CommandResult> => {
            options.onStdoutLine("01-01 00:00:00.000  42  42 I Fake: ready");
            return completion;
          }
        };
      }
      : undefined;
    this.dumpLogcat = this.capabilities.logs
      ? (options: RuntimeDumpLogcatOptions): Promise<CommandResult> => {
        this.calls.push(`dumpLogcat:${String(options.maxLines)}`);
        return Promise.resolve(successResult());
      }
      : undefined;
  }

  public openUiSnapshots(): Promise<UiSnapshotProvider> {
    this.calls.push("openUiSnapshots");
    this.openedUiSnapshots ??= this.uiSnapshotProvider;
    return Promise.resolve(this.openedUiSnapshots);
  }

  public isInstalled(app: RuntimeAppQuery): Promise<boolean> {
    this.calls.push(`isInstalled:${app.packageName}`);
    return Promise.resolve(this.state.installed ?? true);
  }

  public launchApp(options: RuntimeLaunchOptions): Promise<CommandResult> {
    this.calls.push(`launchApp:${options.packageName}:${options.activity}`);
    return Promise.resolve(successResult());
  }

  public forceStop(app: RuntimeAppQuery): Promise<CommandResult> {
    this.calls.push(`forceStop:${app.packageName}`);
    return Promise.resolve(successResult());
  }

  public tap(point: { x: number; y: number }): Promise<CommandResult> {
    this.calls.push(`tap:${String(point.x)},${String(point.y)}`);
    return Promise.resolve(successResult());
  }

  public longClick(
    point: { x: number; y: number },
    durationMs: number
  ): Promise<CommandResult> {
    this.calls.push(
      `longClick:${String(point.x)},${String(point.y)}:${String(durationMs)}`
    );
    return Promise.resolve(successResult());
  }

  public swipe(
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs: number
  ): Promise<CommandResult> {
    this.calls.push([
      "swipe",
      String(from.x),
      String(from.y),
      String(to.x),
      String(to.y),
      String(durationMs)
    ].join(":"));
    return Promise.resolve(successResult());
  }

  public back(): Promise<CommandResult> {
    this.calls.push("back");
    return Promise.resolve(successResult());
  }

  public inputText(text: string): Promise<CommandResult> {
    this.calls.push(`inputText:${text}`);
    return Promise.resolve(successResult());
  }

  public captureScreenshot(
    options: RuntimeScreenshotOptions
  ): Promise<CommandResult> {
    this.calls.push(`captureScreenshot:${options.outputPath}`);
    return Promise.resolve(successResult());
  }

  public close(): Promise<void> {
    this.calls.push("close");
    const opened = this.openedUiSnapshots;
    this.openedUiSnapshots = undefined;
    return opened === undefined
      ? Promise.resolve()
      : opened.close();
  }
}

export class FakeRuntimeBackend implements RuntimeBackend {
  public readonly descriptor: RuntimeBackendDescriptor;
  public readonly capabilities: RuntimeCapabilities;
  public readonly devices: readonly DeviceInfo[];
  public readonly openCalls: OpenRuntimeSessionOptions[] = [];
  public readonly sessions: FakeRuntimeSession[] = [];

  public createSession: (
    options: OpenRuntimeSessionOptions
  ) => RuntimeSession;

  public constructor(options: {
    capabilities?: RuntimeCapabilities | undefined;
    devices?: readonly DeviceInfo[] | undefined;
    sessions?: ((options: OpenRuntimeSessionOptions) => RuntimeSession) | undefined;
  } = {}) {
    const capabilities = options.capabilities ?? fakeRuntimeCapabilities();
    this.capabilities = capabilities;
    this.devices = options.devices ?? [
      { serial: "emulator-5554", status: "device" }
    ];
    this.createSession = options.sessions ?? ((
      sessionOptions: OpenRuntimeSessionOptions
    ): RuntimeSession => {
      const session = new FakeRuntimeSession({
        descriptor: this.descriptor,
        deviceSerial: sessionOptions.deviceSerial
      });
      this.sessions.push(session);
      return session;
    });
    this.descriptor = {
      id: "adb",
      adapterVersion: FAKE_RUNTIME_ADAPTER_VERSION,
      configSha256: createHash("sha256").update(JSON.stringify({
        adapterVersion: FAKE_RUNTIME_ADAPTER_VERSION,
        capabilities
      })).digest("hex"),
      capabilities
    };
  }

  public listDevices(): Promise<readonly DeviceInfo[]> {
    return Promise.resolve(this.devices);
  }

  public openSession(
    options: OpenRuntimeSessionOptions
  ): Promise<RuntimeSession> {
    this.openCalls.push(options);
    return Promise.resolve(this.createSession(options));
  }
}
