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
  RuntimeBackend,
  RuntimeLaunchOptions,
  RuntimeSession
} from "../../ports/runtime-backend.js";
import type { Point } from "../../domain/geometry.js";
import type { ForegroundComponent } from "../../domain/activity.js";
import type { AppProcess } from "../../domain/app-process.js";
import type { WindowTopology } from "../../domain/window-hierarchy.js";
import { runtimeCapabilityMissing } from "../../ports/runtime-capability.js";

export interface RuntimeBackendAdbBridgeDependencies {
  backend: RuntimeBackend;
}

export class RuntimeBackendAdbBridge implements AdbPort {
  private readonly sessions = new Map<string, Promise<RuntimeSession>>();

  public constructor(
    private readonly dependencies: RuntimeBackendAdbBridgeDependencies
  ) {}

  public devices(signal?: AbortSignal): Promise<readonly DeviceInfo[]> {
    return this.dependencies.backend.listDevices(signal);
  }

  public deviceIdentity(identity: AppIdentity): Promise<DeviceIdentity> {
    return this.session(identity.deviceSerial).then((session) => {
      if (session.deviceIdentity === undefined) {
        return Promise.reject(runtimeCapabilityMissing(
          session.descriptor.id,
          "deviceIdentity"
        ));
      }
      return session.deviceIdentity(appQuery(identity));
    });
  }

  public foregroundComponent(
    identity: AppIdentity
  ): Promise<ForegroundComponent> {
    return this.session(identity.deviceSerial).then((session) => {
      if (session.foregroundComponent === undefined) {
        return Promise.reject(runtimeCapabilityMissing(
          session.descriptor.id,
          "foregroundComponent"
        ));
      }
      return session.foregroundComponent(appQuery(identity));
    });
  }

  public currentActivity(identity: AppIdentity): Promise<string> {
    return this.session(identity.deviceSerial).then((session) => {
      if (session.currentActivity === undefined) {
        return Promise.reject(runtimeCapabilityMissing(
          session.descriptor.id,
          "currentActivity"
        ));
      }
      return session.currentActivity(appQuery(identity));
    });
  }

  public async isInstalled(identity: AppIdentity): Promise<boolean> {
    const session = await this.session(identity.deviceSerial);
    return session.isInstalled(appQuery(identity));
  }

  public async launchActivity(
    options: LaunchActivityOptions
  ): Promise<CommandResult> {
    const session = await this.session(options.deviceSerial);
    return session.launchApp(launchOptions(options));
  }

  public startActivityByIntent(
    options: StartActivityByIntentOptions
  ): Promise<CommandResult> {
    return this.session(options.deviceSerial).then((session) => {
      if (session.startActivityByIntent === undefined) {
        return Promise.reject(runtimeCapabilityMissing(
          session.descriptor.id,
          "startActivityByIntent"
        ));
      }
      return session.startActivityByIntent({
        action: options.action,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs })
      });
    });
  }

  public resolveLauncherActivity(): Promise<ResolvedActivity | undefined> {
    return Promise.reject(new Error(
      "resolveLauncherActivity is not available through the runtime backend SPI"
    ));
  }

  public async forceStop(identity: AppIdentity): Promise<CommandResult> {
    const session = await this.session(identity.deviceSerial);
    return session.forceStop(appQuery(identity));
  }

  public appProcesses(
    identity: AppIdentity
  ): Promise<readonly AppProcess[]> {
    return this.session(identity.deviceSerial).then((session) => {
      if (session.appProcesses === undefined) {
        return Promise.reject(runtimeCapabilityMissing(
          session.descriptor.id,
          "appProcesses"
        ));
      }
      return session.appProcesses(appQuery(identity));
    });
  }

  public windowTopology(
    identity: AppIdentity
  ): Promise<WindowTopology> {
    return this.session(identity.deviceSerial).then((session) => {
      if (session.windowTopology === undefined) {
        return Promise.reject(runtimeCapabilityMissing(
          session.descriptor.id,
          "windowTopology"
        ));
      }
      return session.windowTopology(appQuery(identity));
    });
  }

  public async tap(
    point: Point,
    deviceSerial: string,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    const session = await this.session(deviceSerial);
    return session.tap(point, signal);
  }

  public async longClick(
    point: Point,
    durationMs: number,
    deviceSerial: string,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    const session = await this.session(deviceSerial);
    return session.longClick(point, durationMs, signal);
  }

  public async swipe(
    from: Point,
    to: Point,
    durationMs: number,
    deviceSerial: string,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    const session = await this.session(deviceSerial);
    return session.swipe(from, to, durationMs, signal);
  }

  public async back(
    deviceSerial: string,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    const session = await this.session(deviceSerial);
    return session.back(signal);
  }

  public async inputText(
    text: string,
    deviceSerial: string,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    const session = await this.session(deviceSerial);
    return session.inputText(text, signal);
  }

  public startLogcat(options: LogcatOptions): RunningCommand {
    const opened = this.session(options.deviceSerial).then((session) => {
      if (session.startLogcat === undefined) {
        throw runtimeCapabilityMissing(
          session.descriptor.id,
          "startLogcat"
        );
      }
      return session.startLogcat({
        onStdoutLine: options.onStdoutLine,
        ...(options.onStderrLine === undefined
          ? {}
          : { onStderrLine: options.onStderrLine }),
        ...(options.signal === undefined ? {} : { signal: options.signal })
      });
    });
    return {
      started: opened.then((running) => running.started),
      completion: opened.then((running) => running.completion),
      stop: (): Promise<CommandResult> => opened.then((running) => (
        running.stop()
      ))
    };
  }

  public dumpLogcat(
    options: DumpLogcatOptions
  ): Promise<CommandResult> {
    return this.session(options.deviceSerial).then((session) => {
      if (session.dumpLogcat === undefined) {
        return Promise.reject(runtimeCapabilityMissing(
          session.descriptor.id,
          "dumpLogcat"
        ));
      }
      return session.dumpLogcat({
        maxLines: options.maxLines,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs })
      });
    });
  }

  public async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => (
      session.then(
        (opened): Promise<void> => opened.close(),
        () => undefined
      )
    )));
  }

  private session(deviceSerial: string): Promise<RuntimeSession> {
    const existing = this.sessions.get(deviceSerial);
    if (existing !== undefined) {
      return existing;
    }
    const opened = this.dependencies.backend.openSession({ deviceSerial });
    opened.catch(() => {
      if (this.sessions.get(deviceSerial) === opened) {
        this.sessions.delete(deviceSerial);
      }
    });
    this.sessions.set(deviceSerial, opened);
    return opened;
  }
}

function appQuery(identity: AppIdentity): RuntimeAppQuery {
  return {
    packageName: identity.packageName,
    ...(identity.signal === undefined ? {} : { signal: identity.signal }),
    ...(identity.timeoutMs === undefined
      ? {}
      : { timeoutMs: identity.timeoutMs })
  };
}

function launchOptions(
  options: LaunchActivityOptions
): RuntimeLaunchOptions {
  return {
    packageName: options.packageName,
    activity: options.activity,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs })
  };
}
