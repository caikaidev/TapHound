import { createHash } from "node:crypto";

import type {
  AdbPort,
  AppIdentity,
  DeviceIdentity
} from "../../ports/adb.js";
import type {
  AnnotatedScreenResolverPort
} from "../../ports/annotated-screen-resolver.js";
import type {
  CommandResult,
  RunningCommand
} from "../../ports/process-runner.js";
import type {
  OpenRuntimeSessionOptions,
  OpenRuntimeUiSnapshotsOptions,
  RuntimeAppQuery,
  RuntimeBackend,
  RuntimeDumpLogcatOptions,
  RuntimeIntentOptions,
  RuntimeLaunchOptions,
  RuntimeLogcatStreamOptions,
  RuntimeScreenshotOptions,
  RuntimeSession
} from "../../ports/runtime-backend.js";
import type { ScreenshotPort } from "../../ports/screenshot.js";
import type {
  UiSnapshotProvider,
  UiSnapshotProviderFactory
} from "../../ports/ui-snapshot.js";
import type { UiStabilityProbe } from "../../ports/ui-stability.js";
import type { ForegroundComponent } from "../../domain/activity.js";
import type { AppProcess } from "../../domain/app-process.js";
import type { Point } from "../../domain/geometry.js";
import type {
  DeviceInfo,
  RuntimeBackendDescriptor,
  RuntimeCapabilities
} from "../../domain/runtime.js";
import type { WindowTopology } from "../../domain/window-hierarchy.js";

export const ADB_RUNTIME_ADAPTER_VERSION = "adb-runtime-v1";
export const DEFAULT_RUNTIME_UI_SNAPSHOT_TIMEOUT_MS = 5000;

export function adbRuntimeCapabilities(): RuntimeCapabilities {
  return {
    layoutSnapshot: true,
    screenshot: true,
    annotatedScreens: true,
    frameStatsIdle: true,
    logs: true,
    processDiscovery: true,
    windowTopology: true,
    intentStart: true,
    foregroundActivity: true
  };
}

function appIdentity(
  query: RuntimeAppQuery,
  deviceSerial: string
): AppIdentity {
  return {
    packageName: query.packageName,
    deviceSerial,
    ...(query.signal === undefined ? {} : { signal: query.signal }),
    ...(query.timeoutMs === undefined ? {} : { timeoutMs: query.timeoutMs })
  };
}

export interface AdbRuntimeSessionDependencies {
  adb: AdbPort;
  screenshots: ScreenshotPort;
  annotatedScreens: AnnotatedScreenResolverPort;
  uiStability: UiStabilityProbe;
  uiSnapshotFactory: UiSnapshotProviderFactory;
  deviceSerial: string;
  descriptor: RuntimeBackendDescriptor;
}

export class AdbRuntimeSession implements RuntimeSession {
  private uiSnapshotProvider:
    | Promise<UiSnapshotProvider>
    | undefined;

  public constructor(
    private readonly dependencies: AdbRuntimeSessionDependencies
  ) {}

  public get descriptor(): RuntimeBackendDescriptor {
    return this.dependencies.descriptor;
  }

  public get deviceSerial(): string {
    return this.dependencies.deviceSerial;
  }

  public get deviceIdentity():
    | ((app: RuntimeAppQuery) => Promise<DeviceIdentity>)
    | undefined {
    if (this.dependencies.adb.deviceIdentity === undefined) {
      return undefined;
    }
    return (app: RuntimeAppQuery): Promise<DeviceIdentity> => {
      const current = this.dependencies.adb.deviceIdentity;
      if (current === undefined) {
        return Promise.reject(
          new Error("deviceIdentity is unavailable")
        );
      }
      return current(
        appIdentity(app, this.dependencies.deviceSerial)
      );
    };
  }

  public openUiSnapshots(
    options?: OpenRuntimeUiSnapshotsOptions
  ): Promise<UiSnapshotProvider> {
    if (this.uiSnapshotProvider !== undefined) {
      return this.uiSnapshotProvider;
    }
    const opened = this.dependencies.uiSnapshotFactory.open({
      deviceSerial: this.dependencies.deviceSerial,
      timeoutMs: options?.timeoutMs
        ?? DEFAULT_RUNTIME_UI_SNAPSHOT_TIMEOUT_MS,
      ...(options?.backend === undefined
        ? {}
        : { backend: options.backend }),
      ...(options?.cacheEnabled === undefined
        ? {}
        : { cacheEnabled: options.cacheEnabled }),
      ...(options?.signal === undefined ? {} : { signal: options.signal })
    });
    opened.catch(() => {
      if (this.uiSnapshotProvider === opened) {
        this.uiSnapshotProvider = undefined;
      }
    });
    this.uiSnapshotProvider = opened;
    return opened;
  }

  public get annotatedScreens(): AnnotatedScreenResolverPort {
    return this.dependencies.annotatedScreens;
  }

  public get uiStability(): UiStabilityProbe {
    return this.dependencies.uiStability;
  }

  public isInstalled(app: RuntimeAppQuery): Promise<boolean> {
    return this.dependencies.adb.isInstalled(
      appIdentity(app, this.dependencies.deviceSerial)
    );
  }

  public launchApp(
    options: RuntimeLaunchOptions
  ): Promise<CommandResult> {
    return this.dependencies.adb.launchActivity({
      packageName: options.packageName,
      activity: options.activity,
      deviceSerial: this.dependencies.deviceSerial,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs })
    });
  }

  public forceStop(app: RuntimeAppQuery): Promise<CommandResult> {
    return this.dependencies.adb.forceStop(
      appIdentity(app, this.dependencies.deviceSerial)
    );
  }

  public currentActivity(app: RuntimeAppQuery): Promise<string> {
    return this.dependencies.adb.currentActivity(
      appIdentity(app, this.dependencies.deviceSerial)
    );
  }

  public foregroundComponent(
    app: RuntimeAppQuery
  ): Promise<ForegroundComponent> {
    return this.dependencies.adb.foregroundComponent(
      appIdentity(app, this.dependencies.deviceSerial)
    );
  }

  public appProcesses(app: RuntimeAppQuery): Promise<readonly AppProcess[]> {
    return this.dependencies.adb.appProcesses(
      appIdentity(app, this.dependencies.deviceSerial)
    );
  }

  public windowTopology(app: RuntimeAppQuery): Promise<WindowTopology> {
    return this.dependencies.adb.windowTopology(
      appIdentity(app, this.dependencies.deviceSerial)
    );
  }

  public tap(point: Point, signal?: AbortSignal): Promise<CommandResult> {
    return this.dependencies.adb.tap(
      point,
      this.dependencies.deviceSerial,
      signal
    );
  }

  public longClick(
    point: Point,
    durationMs: number,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    return this.dependencies.adb.longClick(
      point,
      durationMs,
      this.dependencies.deviceSerial,
      signal
    );
  }

  public swipe(
    from: Point,
    to: Point,
    durationMs: number,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    return this.dependencies.adb.swipe(
      from,
      to,
      durationMs,
      this.dependencies.deviceSerial,
      signal
    );
  }

  public back(signal?: AbortSignal): Promise<CommandResult> {
    return this.dependencies.adb.back(this.dependencies.deviceSerial, signal);
  }

  public inputText(
    text: string,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    return this.dependencies.adb.inputText(
      text,
      this.dependencies.deviceSerial,
      signal
    );
  }

  public startLogcat(
    options: RuntimeLogcatStreamOptions
  ): RunningCommand {
    return this.dependencies.adb.startLogcat({
      deviceSerial: this.dependencies.deviceSerial,
      onStdoutLine: options.onStdoutLine,
      ...(options.onStderrLine === undefined
        ? {}
        : { onStderrLine: options.onStderrLine }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
  }

  public dumpLogcat(
    options: RuntimeDumpLogcatOptions
  ): Promise<CommandResult> {
    return this.dependencies.adb.dumpLogcat({
      deviceSerial: this.dependencies.deviceSerial,
      maxLines: options.maxLines,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs })
    });
  }

  public captureScreenshot(
    options: RuntimeScreenshotOptions
  ): Promise<CommandResult> {
    return this.dependencies.screenshots.capture({
      outputPath: options.outputPath,
      deviceSerial: this.dependencies.deviceSerial,
      ...(options.annotate === undefined ? {} : { annotate: options.annotate }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs })
    });
  }

  public startActivityByIntent(
    options: RuntimeIntentOptions
  ): Promise<CommandResult> {
    return this.dependencies.adb.startActivityByIntent({
      action: options.action,
      deviceSerial: this.dependencies.deviceSerial,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs })
    });
  }

  public close(): Promise<void> {
    const provider = this.uiSnapshotProvider;
    if (provider === undefined) {
      return Promise.resolve();
    }
    this.uiSnapshotProvider = undefined;
    return provider.then(
      (snapshotProvider): Promise<void> => snapshotProvider.close(),
      () => undefined
    );
  }
}

export interface AdbRuntimeBackendDependencies {
  adb: AdbPort;
  screenshots: ScreenshotPort;
  annotatedScreens: AnnotatedScreenResolverPort;
  uiStability: UiStabilityProbe;
  uiSnapshots: UiSnapshotProviderFactory;
}

export class AdbRuntimeBackend implements RuntimeBackend {
  public readonly descriptor: RuntimeBackendDescriptor;
  public readonly capabilities: RuntimeCapabilities = adbRuntimeCapabilities();

  public constructor(private readonly dependencies: AdbRuntimeBackendDependencies) {
    const capabilities = adbRuntimeCapabilities();
    this.capabilities = capabilities;
    this.descriptor = {
      id: "adb",
      adapterVersion: ADB_RUNTIME_ADAPTER_VERSION,
      configSha256: createHash("sha256").update(JSON.stringify({
        id: "adb",
        adapterVersion: ADB_RUNTIME_ADAPTER_VERSION,
        capabilities
      })).digest("hex"),
      capabilities
    };
  }

  public listDevices(signal?: AbortSignal): Promise<readonly DeviceInfo[]> {
    return this.dependencies.adb.devices(signal);
  }

  public openSession(
    options: OpenRuntimeSessionOptions
  ): Promise<RuntimeSession> {
    return Promise.resolve(new AdbRuntimeSession({
      adb: this.dependencies.adb,
      screenshots: this.dependencies.screenshots,
      annotatedScreens: this.dependencies.annotatedScreens,
      uiStability: this.dependencies.uiStability,
      uiSnapshotFactory: this.dependencies.uiSnapshots,
      deviceSerial: options.deviceSerial,
      descriptor: this.descriptor
    }));
  }
}
