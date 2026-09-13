import type {
  AdbPort,
  AppIdentity,
  DeviceIdentity,
  DeviceInfo,
  DumpLogcatOptions,
  LaunchActivityOptions,
  LogcatOptions,
  ResolvedActivity,
  StartActivityByIntentOptions
} from "../../ports/adb.js";
import type { CommandResult, RunningCommand } from "../../ports/process-runner.js";
import type {
  RuntimeAppQuery,
  RuntimeLaunchOptions,
  RuntimeSession
} from "../../ports/runtime-backend.js";
import type { RuntimeSessionPortViews } from "../../ports/runtime-session-ports.js";
import { runtimeCapabilityMissing } from "../../ports/runtime-capability.js";
import type { ScreenshotOptions, ScreenshotPort } from "../../ports/screenshot.js";
import type { Point } from "../../domain/geometry.js";
import type { ForegroundComponent } from "../../domain/activity.js";
import type { AppProcess } from "../../domain/app-process.js";
import type { WindowTopology } from "../../domain/window-hierarchy.js";
import { FailClosedAnnotatedScreenResolver } from "./session-backed-ports.js";

function appQuery(identity: AppIdentity): RuntimeAppQuery {
  return {
    packageName: identity.packageName,
    ...(identity.signal === undefined ? {} : { signal: identity.signal }),
    ...(identity.timeoutMs === undefined
      ? {}
      : { timeoutMs: identity.timeoutMs })
  };
}

function launchOptions(options: LaunchActivityOptions): RuntimeLaunchOptions {
  return {
    packageName: options.packageName,
    activity: options.activity,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs })
  };
}

/**
 * One borrowed `RuntimeSession` exposed as the legacy `AdbPort`. Unlike the
 * `RuntimeBackendAdbBridge`, the view holds a single already-opened session:
 * the serial in every call must match the session's bound serial and device
 * discovery is not available. Level 1 session-first orchestrators feed their
 * `AdbPort`-shaped helpers through this view until Level 2 retypes them.
 */
export class RuntimeSessionAdbView implements AdbPort {
  public constructor(private readonly session: RuntimeSession) {}

  public devices(): Promise<readonly DeviceInfo[]> {
    return Promise.reject(new Error(
      "Device discovery is not available through a runtime session view; "
        + "use the runtime backend instead"
    ));
  }

  public async foregroundComponent(
    identity: AppIdentity
  ): Promise<ForegroundComponent> {
    this.assertBoundSerial(identity.deviceSerial);
    if (this.session.foregroundComponent === undefined) {
      throw runtimeCapabilityMissing(
        this.session.descriptor.id,
        "foregroundComponent"
      );
    }
    return this.session.foregroundComponent(appQuery(identity));
  }

  public async currentActivity(identity: AppIdentity): Promise<string> {
    this.assertBoundSerial(identity.deviceSerial);
    if (this.session.currentActivity === undefined) {
      throw runtimeCapabilityMissing(
        this.session.descriptor.id,
        "currentActivity"
      );
    }
    return this.session.currentActivity(appQuery(identity));
  }

  public async deviceIdentity(identity: AppIdentity): Promise<DeviceIdentity> {
    this.assertBoundSerial(identity.deviceSerial);
    if (this.session.deviceIdentity === undefined) {
      throw runtimeCapabilityMissing(
        this.session.descriptor.id,
        "deviceIdentity"
      );
    }
    return this.session.deviceIdentity(appQuery(identity));
  }

  public async isInstalled(identity: AppIdentity): Promise<boolean> {
    this.assertBoundSerial(identity.deviceSerial);
    return this.session.isInstalled(appQuery(identity));
  }

  public async launchActivity(
    options: LaunchActivityOptions
  ): Promise<CommandResult> {
    this.assertBoundSerial(options.deviceSerial);
    return this.session.launchApp(launchOptions(options));
  }

  public async startActivityByIntent(
    options: StartActivityByIntentOptions
  ): Promise<CommandResult> {
    this.assertBoundSerial(options.deviceSerial);
    if (this.session.startActivityByIntent === undefined) {
      throw runtimeCapabilityMissing(
        this.session.descriptor.id,
        "startActivityByIntent"
      );
    }
    return this.session.startActivityByIntent({
      action: options.action,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs })
    });
  }

  public resolveLauncherActivity(): Promise<ResolvedActivity | undefined> {
    return Promise.reject(new Error(
      "resolveLauncherActivity is not available through the runtime backend SPI"
    ));
  }

  public async forceStop(identity: AppIdentity): Promise<CommandResult> {
    this.assertBoundSerial(identity.deviceSerial);
    return this.session.forceStop(appQuery(identity));
  }

  public async appProcesses(
    identity: AppIdentity
  ): Promise<readonly AppProcess[]> {
    this.assertBoundSerial(identity.deviceSerial);
    if (this.session.appProcesses === undefined) {
      throw runtimeCapabilityMissing(
        this.session.descriptor.id,
        "appProcesses"
      );
    }
    return this.session.appProcesses(appQuery(identity));
  }

  public async windowTopology(
    identity: AppIdentity
  ): Promise<WindowTopology> {
    this.assertBoundSerial(identity.deviceSerial);
    if (this.session.windowTopology === undefined) {
      throw runtimeCapabilityMissing(
        this.session.descriptor.id,
        "windowTopology"
      );
    }
    return this.session.windowTopology(appQuery(identity));
  }

  public async tap(
    point: Point,
    deviceSerial: string,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    this.assertBoundSerial(deviceSerial);
    return this.session.tap(point, signal);
  }

  public async longClick(
    point: Point,
    durationMs: number,
    deviceSerial: string,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    this.assertBoundSerial(deviceSerial);
    return this.session.longClick(point, durationMs, signal);
  }

  public async swipe(
    from: Point,
    to: Point,
    durationMs: number,
    deviceSerial: string,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    this.assertBoundSerial(deviceSerial);
    return this.session.swipe(from, to, durationMs, signal);
  }

  public async back(
    deviceSerial: string,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    this.assertBoundSerial(deviceSerial);
    return this.session.back(signal);
  }

  public async inputText(
    text: string,
    deviceSerial: string,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    this.assertBoundSerial(deviceSerial);
    return this.session.inputText(text, signal);
  }

  public startLogcat(options: LogcatOptions): RunningCommand {
    this.assertBoundSerial(options.deviceSerial);
    if (this.session.startLogcat === undefined) {
      throw runtimeCapabilityMissing(
        this.session.descriptor.id,
        "startLogcat"
      );
    }
    const running = this.session.startLogcat({
      onStdoutLine: options.onStdoutLine,
      ...(options.onStderrLine === undefined
        ? {}
        : { onStderrLine: options.onStderrLine }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
    return {
      started: running.started,
      completion: running.completion,
      stop: (): Promise<CommandResult> => running.stop()
    };
  }

  public async dumpLogcat(
    options: DumpLogcatOptions
  ): Promise<CommandResult> {
    this.assertBoundSerial(options.deviceSerial);
    if (this.session.dumpLogcat === undefined) {
      throw runtimeCapabilityMissing(
        this.session.descriptor.id,
        "dumpLogcat"
      );
    }
    return this.session.dumpLogcat({
      maxLines: options.maxLines,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs })
    });
  }

  private assertBoundSerial(deviceSerial: string): void {
    if (deviceSerial !== this.session.deviceSerial) {
      throw new Error(
        `Runtime session bound to "${this.session.deviceSerial}" cannot `
          + `serve device "${deviceSerial}"`
      );
    }
  }
}

/** One borrowed session exposed as the serial-keyed `ScreenshotPort`. */
export class SessionBoundScreenshotAdapter implements ScreenshotPort {
  public constructor(private readonly session: RuntimeSession) {}

  public capture(options: ScreenshotOptions): Promise<CommandResult> {
    if (options.deviceSerial !== this.session.deviceSerial) {
      return Promise.reject(new Error(
        `Runtime session bound to "${this.session.deviceSerial}" cannot `
          + `serve device "${options.deviceSerial}"`
      ));
    }
    return this.session.captureScreenshot({
      outputPath: options.outputPath,
      ...(options.annotate === undefined ? {} : { annotate: options.annotate }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
    });
  }
}

/**
 * Legacy port views for one borrowed session: the `AdbPort` view above, a
 * session-bound screenshot port, the session's annotated-screen resolver
 * (fail-closed when the backend lacks the capability), and the required UI
 * stability probe. Session-first orchestrators pass these views to helpers
 * that still speak the legacy port types.
 */
export function runtimeSessionPortViews(
  session: RuntimeSession
): RuntimeSessionPortViews {
  return {
    adb: new RuntimeSessionAdbView(session),
    screenshots: new SessionBoundScreenshotAdapter(session),
    annotatedScreens: session.annotatedScreens
      ?? new FailClosedAnnotatedScreenResolver(session.descriptor.id),
    uiStability: session.uiStability
  };
}
