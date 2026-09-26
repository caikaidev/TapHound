import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

import type { ForegroundComponent } from "../../src/domain/activity.js";
import type { AppProcess } from "../../src/domain/app-process.js";
import type { DisplayViewport, Point } from "../../src/domain/geometry.js";
import type { LayoutElement } from "../../src/domain/layout.js";
import type {
  DeviceInfo,
  RuntimeBackendDescriptor,
  RuntimeCapabilities
} from "../../src/domain/runtime.js";
import type { UiBackendDescriptor } from "../../src/domain/ui-backend.js";
import type { WindowTopology } from "../../src/domain/window-hierarchy.js";
import type { DeviceIdentity } from "../../src/ports/adb.js";
import type {
  CommandResult,
  RunningCommand
} from "../../src/ports/process-runner.js";
import type {
  OpenRuntimeSessionOptions,
  RuntimeAppQuery,
  RuntimeBackend,
  RuntimeDumpLogcatOptions,
  RuntimeLaunchOptions,
  RuntimeLogcatStreamOptions,
  RuntimeScreenshotOptions,
  RuntimeSession
} from "../../src/ports/runtime-backend.js";
import type {
  UiSnapshot,
  UiSnapshotProvider
} from "../../src/ports/ui-snapshot.js";
import type {
  UiStabilityProbe,
  UiStabilitySampleResult
} from "../../src/ports/ui-stability.js";

/**
 * A deterministic, state-machine Android device for golden parity tests.
 *
 * The device answers every query from its current state instead of from a
 * recorded call sequence, so Replay and Generation may poll a different
 * number of times and still observe the same app. Every device call is
 * counted so a test can pin the per-step device cost.
 */

export interface SimulatedScreen {
  /** Defaults to the app under test; another package models an escape (camera, picker). */
  packageName?: string | undefined;
  activity: string;
  layout: readonly LayoutElement[];
  /** Logcat messages (tag, message) the app writes when entering the screen. */
  logs?: readonly { tag: string; message: string }[] | undefined;
}

export type SimulatedTrigger =
  | { action: "tap"; elementId: string }
  | { action: "longClick"; elementId: string }
  | { action: "inputText"; text: string }
  | { action: "back" };

export interface SimulatedTransition {
  from: string;
  on: SimulatedTrigger;
  to: string;
}

export interface SimulatedApp {
  packageName: string;
  launchActivity: string;
  startScreen: string;
  screens: Readonly<Record<string, SimulatedScreen>>;
  transitions: readonly SimulatedTransition[];
}

export const SIMULATED_SERIAL = "sim-5554";
const LAUNCHER_PACKAGE = "com.android.launcher3";
const LAUNCHER_ACTIVITY = "com.android.launcher3.Launcher";

const VIEWPORT: DisplayViewport = {
  width: 1080,
  height: 1920,
  rotation: 0,
  coordinateSpace: "physicalDisplayPixels"
};

const UI_BACKEND: UiBackendDescriptor = {
  id: "system-uiautomator",
  adapterVersion: "simulated-v1",
  configSha256: "0".repeat(64)
};

const CAPABILITIES: RuntimeCapabilities = {
  layoutSnapshot: true,
  screenshot: true,
  annotatedScreens: false,
  frameStatsIdle: false,
  logs: true,
  processDiscovery: true,
  windowTopology: true,
  intentStart: false,
  foregroundActivity: true
};

function ok(stdout = ""): CommandResult {
  return {
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    durationMs: 0,
    timedOut: false,
    cancelled: false
  };
}

function contains(element: LayoutElement, point: Point): boolean {
  const bounds = element.bounds;
  return bounds !== undefined
    && point.x >= bounds.left && point.x < bounds.right
    && point.y >= bounds.top && point.y < bounds.bottom;
}

/** Deepest hit first, then its ancestors: the chain a tap dispatches through. */
function hitChain(
  roots: readonly LayoutElement[],
  point: Point
): LayoutElement[] {
  for (const element of [...roots].reverse()) {
    if (!contains(element, point)) continue;
    return [...hitChain(element.children, point), element];
  }
  return [];
}

function logcatTime(sequence: number): string {
  const millis = String(sequence % 1000).padStart(3, "0");
  return `01-01 00:00:00.${millis}`;
}

export class SimulatedDevice implements RuntimeBackend {
  public readonly descriptor: RuntimeBackendDescriptor = {
    id: "adb",
    adapterVersion: "simulated-v1",
    configSha256: createHash("sha256").update("simulated-v1").digest("hex"),
    capabilities: CAPABILITIES
  };
  public readonly capabilities = CAPABILITIES;

  /** Device-call counts since the last `resetCounts()`. */
  public readonly counts = new Map<string, number>();
  /** Every device call in order since the last `resetCounts()`. */
  public readonly timeline: string[] = [];

  private screen: string | undefined;
  /** The app under test keeps its process while another package is foreground. */
  private running = false;
  private pid = 4000;
  private logSequence = 0;
  private readonly logListeners = new Set<(line: string) => void>();

  public constructor(private readonly app: SimulatedApp) {}

  public get currentScreen(): string | undefined {
    return this.screen;
  }

  public resetCounts(): void {
    this.counts.clear();
    this.timeline.length = 0;
  }

  public countsSnapshot(): Record<string, number> {
    return Object.fromEntries(
      [...this.counts.entries()].sort(([left], [right]) => left.localeCompare(right))
    );
  }

  public listDevices(): Promise<readonly DeviceInfo[]> {
    return Promise.resolve([{ serial: SIMULATED_SERIAL, status: "device" }]);
  }

  public openSession(options: OpenRuntimeSessionOptions): Promise<RuntimeSession> {
    this.record("openSession");
    return Promise.resolve(this.session(options.deviceSerial));
  }

  private record(call: string): void {
    this.counts.set(call, (this.counts.get(call) ?? 0) + 1);
    this.timeline.push(call);
  }

  private current(): SimulatedScreen | undefined {
    return this.screen === undefined ? undefined : this.app.screens[this.screen];
  }

  private enter(screenId: string): void {
    const next = this.app.screens[screenId];
    if (next === undefined) {
      throw new Error(`Simulated app has no screen ${screenId}`);
    }
    this.screen = screenId;
    for (const log of next.logs ?? []) {
      this.logSequence += 1;
      const line = `${logcatTime(this.logSequence)}  ${String(this.pid)}  ${String(this.pid)} I ${log.tag}: ${log.message}`;
      for (const listener of this.logListeners) listener(line);
    }
  }

  private fire(trigger: SimulatedTrigger, chain: readonly string[] = []): void {
    const from = this.screen;
    if (from === undefined) return;
    const matches = (
      candidate: SimulatedApp["transitions"][number],
      elementId?: string
    ): boolean => {
      if (candidate.from !== from || candidate.on.action !== trigger.action) {
        return false;
      }
      if (candidate.on.action === "tap" || candidate.on.action === "longClick") {
        return candidate.on.elementId === elementId;
      }
      if (candidate.on.action === "inputText" && trigger.action === "inputText") {
        return candidate.on.text === trigger.text;
      }
      return true;
    };
    // A touch is handled by the deepest element in the hit chain that reacts.
    const transition = trigger.action === "tap" || trigger.action === "longClick"
      ? chain.map((elementId) => this.app.transitions.find(
          (candidate) => matches(candidate, elementId)
        )).find((candidate) => candidate !== undefined)
      : this.app.transitions.find((candidate) => matches(candidate));
    if (transition !== undefined) this.enter(transition.to);
  }

  private foreground(): ForegroundComponent {
    const screen = this.current();
    return screen === undefined
      ? { packageName: LAUNCHER_PACKAGE, activity: LAUNCHER_ACTIVITY }
      : {
          packageName: screen.packageName ?? this.app.packageName,
          activity: screen.activity
        };
  }

  private snapshot(): UiSnapshot {
    return {
      observationId: `sim-${String(this.timeline.length)}`,
      capturedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 0,
      backend: UI_BACKEND,
      viewport: VIEWPORT,
      roots: this.current()?.layout ?? []
    };
  }

  private session(deviceSerial: string): RuntimeSession {
    const provider: UiSnapshotProvider = {
      descriptor: UI_BACKEND,
      capture: (): Promise<UiSnapshot> => {
        this.record("uiCapture");
        return Promise.resolve(this.snapshot());
      },
      close: (): Promise<void> => Promise.resolve()
    };
    let lastLayout: string | undefined;
    const uiStability: UiStabilityProbe = {
      reset: (): void => {
        lastLayout = undefined;
      },
      sample: (): Promise<UiStabilitySampleResult> => {
        this.record("stabilitySample");
        const layout = this.current()?.layout ?? [];
        const signature = JSON.stringify(layout);
        const changed = lastLayout !== undefined && lastLayout !== signature;
        lastLayout = signature;
        return Promise.resolve({
          changes: changed ? [{ layoutSha256: signature }] : [],
          layout,
          backend: "uiautomator" as const,
          durationMs: 0
        });
      }
    };
    const query = (name: string) => (app: RuntimeAppQuery): void => {
      this.record(name);
      void app;
    };
    return {
      descriptor: this.descriptor,
      deviceSerial,
      openUiSnapshots: (): Promise<UiSnapshotProvider> => {
        this.record("openUiSnapshots");
        return Promise.resolve(provider);
      },
      isInstalled: (app: RuntimeAppQuery): Promise<boolean> => {
        query("isInstalled")(app);
        return Promise.resolve(app.packageName === this.app.packageName);
      },
      launchApp: (options: RuntimeLaunchOptions): Promise<CommandResult> => {
        query("launchApp")(options);
        this.pid += 1;
        this.running = true;
        this.enter(this.app.startScreen);
        return Promise.resolve(ok());
      },
      forceStop: (app: RuntimeAppQuery): Promise<CommandResult> => {
        query("forceStop")(app);
        this.screen = undefined;
        this.running = false;
        return Promise.resolve(ok());
      },
      currentActivity: (app: RuntimeAppQuery): Promise<string> => {
        query("currentActivity")(app);
        return Promise.resolve(this.foreground().activity);
      },
      deviceIdentity: (app: RuntimeAppQuery): Promise<DeviceIdentity> => {
        query("deviceIdentity")(app);
        return Promise.resolve({
          manufacturer: "TapHound",
          model: "Simulated",
          sdkLevel: 34
        });
      },
      foregroundComponent: (app: RuntimeAppQuery): Promise<ForegroundComponent> => {
        query("foregroundComponent")(app);
        return Promise.resolve(this.foreground());
      },
      appProcesses: (app: RuntimeAppQuery): Promise<readonly AppProcess[]> => {
        query("appProcesses")(app);
        return Promise.resolve(this.running
          ? [{ pid: this.pid, name: this.app.packageName }]
          : []);
      },
      windowTopology: (app: RuntimeAppQuery): Promise<WindowTopology> => {
        query("windowTopology")(app);
        return Promise.resolve({
          version: 1,
          status: "unavailable",
          windows: [],
          diagnostic: "simulated device exposes no window topology"
        });
      },
      tap: (point: Point): Promise<CommandResult> => {
        this.record("tap");
        const chain = hitChain(this.current()?.layout ?? [], point)
          .map((element) => element.id);
        this.fire({ action: "tap", elementId: chain[0] ?? "" }, chain);
        return Promise.resolve(ok());
      },
      longClick: (point: Point): Promise<CommandResult> => {
        this.record("longClick");
        const chain = hitChain(this.current()?.layout ?? [], point)
          .map((element) => element.id);
        this.fire({ action: "longClick", elementId: chain[0] ?? "" }, chain);
        return Promise.resolve(ok());
      },
      swipe: (): Promise<CommandResult> => {
        this.record("swipe");
        return Promise.resolve(ok());
      },
      back: (): Promise<CommandResult> => {
        this.record("back");
        this.fire({ action: "back" });
        return Promise.resolve(ok());
      },
      inputText: (text: string): Promise<CommandResult> => {
        this.record("inputText");
        this.fire({ action: "inputText", text });
        return Promise.resolve(ok());
      },
      startLogcat: (options: RuntimeLogcatStreamOptions): RunningCommand => {
        this.record("startLogcat");
        this.logListeners.add(options.onStdoutLine);
        const completion = Promise.resolve(ok());
        return {
          started: Promise.resolve(undefined),
          completion,
          stop: (): Promise<CommandResult> => {
            this.logListeners.delete(options.onStdoutLine);
            return completion;
          }
        };
      },
      dumpLogcat: (options: RuntimeDumpLogcatOptions): Promise<CommandResult> => {
        this.record("dumpLogcat");
        void options;
        return Promise.resolve(ok());
      },
      captureScreenshot: async (
        options: RuntimeScreenshotOptions
      ): Promise<CommandResult> => {
        this.record("captureScreenshot");
        await writeFile(options.outputPath, Buffer.from("simulated-png"));
        return ok();
      },
      annotatedScreens: undefined,
      uiStability,
      startActivityByIntent: undefined,
      close: (): Promise<void> => Promise.resolve()
    };
  }
}
