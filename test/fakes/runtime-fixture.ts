import { vi } from "vitest";

import {
  ReportWriter,
  type PublishedReport
} from "../../src/application/report/report-writer.js";
import type { TapHoundReport } from "../../src/domain/report.js";
import type { VerifyRuntimeDependencies } from "../../src/application/runtime/verify-runtime.js";
import type { TapHoundConfig } from "../../src/domain/config.js";
import type { Journey } from "../../src/domain/journey.js";
import type {
  AdbPort,
  LogcatOptions
} from "../../src/ports/adb.js";
import type {
  AnnotatedScreenResolverPort
} from "../../src/ports/annotated-screen-resolver.js";
import type { UiSnapshotProviderFactory } from "../../src/ports/ui-snapshot.js";
import type { ScreenshotPort } from "../../src/ports/screenshot.js";
import type { UiStabilityProbe } from "../../src/ports/ui-stability.js";
import type { LayoutElement } from "../../src/domain/layout.js";
import type { ArtifactSession } from "../../src/ports/artifact-store.js";
import { MemoryArtifactStore } from "./artifact-store.js";
import { FakeClock } from "./fake-clock.js";
import { commandResult } from "./process-runner.js";
import {
  uiSnapshotFactory,
  uiSnapshotProviderFromLayout
} from "./ui-snapshot.js";

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
  version: 1,
  name: "Search",
  steps: [{
    action: "click",
    locator: { resourceId: "search" },
    activity: {
      before: "com.example.app.MainActivity",
      after: "com.example.app.SearchActivity"
    }
  }]
};

export interface RuntimeFixture {
  order: string[];
  dependencies: VerifyRuntimeDependencies;
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

export function runtimeFixture(): RuntimeFixture {
  const order: string[] = [];
  const artifacts = new MemoryArtifactStore();
  const activities = [
    "com.example.app.MainActivity",
    "com.example.app.MainActivity",
    "com.example.app.SearchActivity"
  ];
  let layoutCalls = 0;
  const sample: UiStabilityProbe["sample"] = vi.fn(() => {
    order.push("idle");
    return Promise.resolve([]);
  });
  const androidCli: RuntimeFixture["androidCli"] = {
    layout: vi.fn(() => {
      layoutCalls += 1;
      order.push(layoutCalls === 1 ? "baseline" : "step-layout");
      return Promise.resolve([{
        id: "search",
        resourceId: "search",
        clickable: true,
        longClickable: true,
        scrollable: true,
        enabled: true,
        bounds: { left: 0, top: 0, right: 100, bottom: 50 },
        children: []
      }]);
    }),
    reset: vi.fn(),
    sample,
    resolve: vi.fn(() => Promise.resolve({ x: 50, y: 25 }))
  };
  const adb: AdbPort = {
    devices: vi.fn(),
    foregroundComponent: vi.fn(),
    currentActivity: vi.fn(() => {
      const value = activities.shift() ?? "com.example.app.SearchActivity";
      order.push(value.endsWith("MainActivity") ? "activity-main" : "activity-search");
      return Promise.resolve(value);
    }),
    isInstalled: vi.fn(() => {
      order.push("install");
      return Promise.resolve(true);
    }),
    launchActivity: vi.fn(() => {
      order.push("launch");
      return Promise.resolve(commandResult());
    }),
    startActivityByIntent: vi.fn(() => Promise.resolve(commandResult())),
    resolveLauncherActivity: vi.fn(() => Promise.resolve(undefined)),
    forceStop: vi.fn(() => {
      order.push("force-stop");
      return Promise.resolve(commandResult());
    }),
    appProcesses: vi.fn(() => {
      order.push("pid");
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
    tap: vi.fn(() => {
      order.push("action");
      return Promise.resolve(commandResult());
    }),
    longClick: vi.fn(() => Promise.resolve(commandResult())),
    swipe: vi.fn(() => Promise.resolve(commandResult())),
    back: vi.fn(() => Promise.resolve(commandResult())),
    inputText: vi.fn(() => Promise.resolve(commandResult())),
    startLogcat: vi.fn((options: LogcatOptions) => {
      order.push("logcat-start");
      options.onStdoutLine("07-19 10:00:00.000  42  42 I TapHound: ready");
      const completion = Promise.resolve(commandResult());
      return {
        started: Promise.resolve(undefined),
        completion,
        stop: vi.fn(() => {
          order.push("logcat-stop");
          return completion;
        })
      };
    }),
    dumpLogcat: vi.fn(() => Promise.resolve(commandResult()))
  };
  const writer = new ReportWriter();
  const screenshots: ScreenshotPort = {
    capture: vi.fn(() => {
      order.push("screenshot");
      return Promise.resolve(commandResult());
    })
  };
  const uiSnapshots = uiSnapshotFactory(
    uiSnapshotProviderFromLayout(androidCli.layout)
  );
  return {
    order,
    androidCli,
    screenshots,
    uiSnapshots,
    adb,
    artifacts,
    dependencies: {
      screenshots,
      annotatedScreens: androidCli,
      uiStability: androidCli,
      uiSnapshots,
      adb,
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
