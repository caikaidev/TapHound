import { vi } from "vitest";

import {
  ReportWriter,
  type PublishedReport
} from "../../src/application/report/report-writer.js";
import type { TapHoundReport } from "../../src/domain/report.js";
import type { VerifyRuntimeDependencies } from "../../src/application/runtime/verify-runtime.js";
import type { TapHoundConfig } from "../../src/domain/config.js";
import type { Journey } from "../../src/domain/journey.js";
import { AdbRuntimeBackend } from "../../src/adapters/runtime/adb-runtime-backend.js";
import { runtimeSessionPortViews } from "../../src/adapters/runtime/session-adb-view.js";
import type {
  AdbPort,
  AppIdentity,
  LaunchActivityOptions,
  LogcatOptions
} from "../../src/ports/adb.js";
import type {
  AnnotatedScreenResolverPort
} from "../../src/ports/annotated-screen-resolver.js";
import type { UiSnapshotProviderFactory } from "../../src/ports/ui-snapshot.js";
import type { ScreenshotOptions, ScreenshotPort } from "../../src/ports/screenshot.js";
import type {
  UiStabilityProbe,
  UiStabilitySampleOptions
} from "../../src/ports/ui-stability.js";
import type { LayoutElement } from "../../src/domain/layout.js";
import type { Point } from "../../src/domain/geometry.js";
import type { ArtifactSession } from "../../src/ports/artifact-store.js";
import { MemoryArtifactStore } from "./artifact-store.js";
import { FakeClock } from "./fake-clock.js";
import { commandResult } from "./process-runner.js";
import { uiSnapshotFactoryFromLayout } from "./ui-snapshot.js";

export const runtimeConfig: TapHoundConfig = {
  version: 1,
  run: {
    packageName: "com.example.app",
    activity: ".MainActivity"
  },
  idle: {
    strategy: "hybrid",
    pollIntervalMs: 100,
    stablePolls: 1,
    timeoutMs: 500
  },
  artifactsDir: ".taphound/build/runs"
};

export const runtimeJourney: Journey = {
  version: 2,
  name: "Search",
  devices: [{ role: "default" }],
  steps: [{
    action: "click",
    locator: { resourceId: "search" },
    activity: {
      before: "com.example.app.MainActivity",
      after: "com.example.app.SearchActivity"
    }
  }]
};

export interface RuntimeFixtureOptions {
  serials?: readonly string[];
}

export interface RuntimeFixture {
  order: string[];
  dependencies: VerifyRuntimeDependencies;
  backend: AdbRuntimeBackend;
  androidCli: UiStabilityProbe & AnnotatedScreenResolverPort & {
    layout: (options: {
      deviceSerial: string;
      signal?: AbortSignal | undefined;
      timeoutMs?: number | undefined;
    }) => Promise<readonly LayoutElement[]>;
  };
  screenshots: ScreenshotPort;
  uiSnapshots: UiSnapshotProviderFactory;
  adb: AdbPort;
  artifacts: MemoryArtifactStore;
}

const DEFAULT_ACTIVITY_SCRIPT = [
  "com.example.app.MainActivity",
  "com.example.app.MainActivity",
  "com.example.app.SearchActivity"
];

const SEARCH_LAYOUT: readonly LayoutElement[] = [{
  id: "search",
  resourceId: "search",
  clickable: true,
  longClickable: true,
  scrollable: true,
  enabled: true,
  bounds: { left: 0, top: 0, right: 100, bottom: 50 },
  children: []
}];

export function runtimeFixture(
  options: RuntimeFixtureOptions = {}
): RuntimeFixture {
  const serials = options.serials !== undefined && options.serials.length > 0
    ? options.serials
    : ["emulator-5554"];
  const multi = serials.length > 1;
  const track = (entry: string, deviceSerial: string): string => (
    multi ? `${entry}@${deviceSerial}` : entry
  );

  const order: string[] = [];
  const artifacts = new MemoryArtifactStore();
  const activitiesBySerial = new Map<string, string[]>(
    serials.map((serial) => [serial, [...DEFAULT_ACTIVITY_SCRIPT]])
  );
  const activityScript = (deviceSerial: string): string[] => {
    let script = activitiesBySerial.get(deviceSerial);
    if (script === undefined) {
      script = [...DEFAULT_ACTIVITY_SCRIPT];
      activitiesBySerial.set(deviceSerial, script);
    }
    return script;
  };
  const layoutCallsBySerial = new Map<string, number>();
  const sample: UiStabilityProbe["sample"] = vi.fn(
    (probeOptions: UiStabilitySampleOptions) => {
      order.push(track("idle", probeOptions.deviceSerial));
      return Promise.resolve([]);
    }
  );
  const androidCli: RuntimeFixture["androidCli"] = {
    layout: vi.fn(
      (
        layoutOptions: {
          deviceSerial: string;
          signal?: AbortSignal | undefined;
          timeoutMs?: number | undefined;
        }
      ) => {
        const calls = (layoutCallsBySerial.get(layoutOptions.deviceSerial) ?? 0) + 1;
        layoutCallsBySerial.set(layoutOptions.deviceSerial, calls);
        order.push(
          track(calls === 1 ? "baseline" : "step-layout", layoutOptions.deviceSerial)
        );
        return Promise.resolve([...SEARCH_LAYOUT]);
      }
    ),
    reset: vi.fn(),
    sample,
    resolve: vi.fn(() => Promise.resolve({ x: 50, y: 25 }))
  };
  const adb: AdbPort = {
    devices: vi.fn(),
    foregroundComponent: vi.fn(),
    currentActivity: vi.fn((identity: AppIdentity) => {
      const value = activityScript(identity.deviceSerial).shift()
        ?? "com.example.app.SearchActivity";
      order.push(track(
        value.endsWith("MainActivity") ? "activity-main" : "activity-search",
        identity.deviceSerial
      ));
      return Promise.resolve(value);
    }),
    isInstalled: vi.fn((identity: AppIdentity) => {
      order.push(track("install", identity.deviceSerial));
      return Promise.resolve(true);
    }),
    launchActivity: vi.fn((launchOptions: LaunchActivityOptions) => {
      order.push(track("launch", launchOptions.deviceSerial));
      return Promise.resolve(commandResult());
    }),
    startActivityByIntent: vi.fn(() => Promise.resolve(commandResult())),
    resolveLauncherActivity: vi.fn(() => Promise.resolve(undefined)),
    forceStop: vi.fn((identity: AppIdentity) => {
      order.push(track("force-stop", identity.deviceSerial));
      return Promise.resolve(commandResult());
    }),
    appProcesses: vi.fn((identity: AppIdentity) => {
      order.push(track("pid", identity.deviceSerial));
      return Promise.resolve([
        { pid: 42, name: "com.example.app" },
        { pid: 77, name: "com.example.app:remote" }
      ]);
    }),
    windowTopology: vi.fn(() => Promise.resolve({
      version: 1 as const,
      status: "unavailable" as const,
      windows: [],
      diagnostic: "not used by Replay"
    })),
    tap: vi.fn((_point: Point, deviceSerial: string) => {
      order.push(track("action", deviceSerial));
      return Promise.resolve(commandResult());
    }),
    longClick: vi.fn(() => Promise.resolve(commandResult())),
    swipe: vi.fn(() => Promise.resolve(commandResult())),
    back: vi.fn(() => Promise.resolve(commandResult())),
    inputText: vi.fn(() => Promise.resolve(commandResult())),
    startLogcat: vi.fn((logcatOptions: LogcatOptions) => {
      order.push(track("logcat-start", logcatOptions.deviceSerial));
      logcatOptions.onStdoutLine("07-19 10:00:00.000  42  42 I TapHound: ready");
      const completion = Promise.resolve(commandResult());
      return {
        started: Promise.resolve(undefined),
        completion,
        stop: vi.fn(() => {
          order.push(track("logcat-stop", logcatOptions.deviceSerial));
          return completion;
        })
      };
    }),
    dumpLogcat: vi.fn(() => Promise.resolve(commandResult()))
  };
  const writer = new ReportWriter();
  const screenshots: ScreenshotPort = {
    capture: vi.fn((screenshotOptions: ScreenshotOptions) => {
      order.push(track("screenshot", screenshotOptions.deviceSerial));
      return Promise.resolve(commandResult());
    })
  };
  const uiSnapshots = uiSnapshotFactoryFromLayout(androidCli.layout);
  const backend = new AdbRuntimeBackend({
    adb,
    screenshots,
    annotatedScreens: androidCli,
    uiStability: androidCli,
    uiSnapshots
  });
  return {
    order,
    androidCli,
    screenshots,
    uiSnapshots,
    adb,
    backend,
    artifacts,
    dependencies: {
      sessions: backend,
      sessionPorts: runtimeSessionPortViews,
      clock: new FakeClock(),
      artifactStore: artifacts,
      reportWriter: {
        writeAndPublish: async (
          session: ArtifactSession,
          report: TapHoundReport
        ): Promise<PublishedReport> => {
          order.push("report");
          return writer.writeAndPublish(session, report);
        }
      },
      now: () => new Date("2026-07-19T10:00:00.000Z"),
      createRunId: () => "run-123"
    }
  };
}
