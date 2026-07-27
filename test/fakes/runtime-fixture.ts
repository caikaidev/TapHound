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
import type { AndroidCliPort } from "../../src/ports/android-cli.js";
import type { ArtifactSession } from "../../src/ports/artifact-store.js";
import { MemoryArtifactStore } from "./artifact-store.js";
import { FakeClock } from "./fake-clock.js";
import { commandResult } from "./process-runner.js";

export const runtimeConfig: TapHoundConfig = {
  version: 1,
  run: {
    packageName: "com.example.app",
    activity: ".MainActivity"
  },
  idle: {
    pollIntervalMs: 100,
    stablePolls: 1,
    timeoutMs: 500
  },
  artifactsDir: ".taphound/runs"
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
  androidCli: AndroidCliPort;
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
  const androidCli: AndroidCliPort = {
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
    layoutDiff: vi.fn(() => {
      order.push("idle");
      return Promise.resolve([]);
    }),
    captureScreen: vi.fn(() => {
      order.push("screenshot");
      return Promise.resolve(commandResult());
    }),
    resolveScreen: vi.fn(() => Promise.resolve({ x: 50, y: 25 }))
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
    })
  };
  const writer = new ReportWriter();
  return {
    order,
    androidCli,
    adb,
    artifacts,
    dependencies: {
      androidCli,
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
